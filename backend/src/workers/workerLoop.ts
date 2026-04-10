import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BROWSER_SLOT_KEY,
  type RedisClient,
  isMemoryRedis,
  resetMemoryBrowserSlotCounter,
} from "../queues/redisClient.js";
import { processDueTasks } from "./taskRunner.js";

/** Reinicia slots y desbloquea tareas cortas que quedaron en running tras un crash. */
export async function prepareWorkerRuntime(sb: SupabaseClient, redis: RedisClient): Promise<void> {
  if (isMemoryRedis(redis)) {
    resetMemoryBrowserSlotCounter();
  } else {
    await (redis as import("ioredis").Redis).set(BROWSER_SLOT_KEY, "0").catch(() => {});
  }
  console.log("[worker] Contador de slots de navegador reiniciado a 0.");

  try {
    const shortActions = ["verify_session", "session_check", "poll_comments"];
    const { data: reset } = await sb
      .from("tasks")
      .update({ status: "pending", error_message: "worker_restarted", locked_at: null })
      .eq("status", "running")
      .in("action", shortActions)
      .select("id");
    if (reset && reset.length > 0) {
      console.log(`[worker] Reset de ${reset.length} tarea(s) cortas en «running» al arrancar.`);
    }
  } catch (startErr) {
    console.warn("[worker] startup task reset falló (no crítico):", startErr instanceof Error ? startErr.message : startErr);
  }
}

function pollIntervalMs(): number {
  return Number(process.env.WORKER_POLL_MS ?? 8000);
}

/**
 * Bucle periódico que ejecuta la cola (Playwright). Puede vivir en el API o en proceso dedicado.
 */
export function startPeriodicTaskProcessing(
  sb: SupabaseClient,
  redis: RedisClient,
  logPrefix: string
): ReturnType<typeof setInterval> {
  const ms = pollIntervalMs();
  console.log(
    `${logPrefix} automation poll cada ${ms}ms | headless=${process.env.PLAYWRIGHT_HEADLESS !== "false"}`
  );

  let consecutiveErrors = 0;
  const loop = async () => {
    try {
      await processDueTasks(sb, redis);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      const backoffMs = Math.min(60_000, ms * 2 ** Math.min(consecutiveErrors - 1, 5));
      console.error(
        `${logPrefix} loop error #${consecutiveErrors} (backoff ${backoffMs}ms):`,
        e instanceof Error ? e.message : e
      );
      if (consecutiveErrors >= 10) {
        console.error(`${logPrefix} 10 errores consecutivos — revisa DB/Redis.`);
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  };

  void loop();
  return setInterval(loop, ms);
}

/**
 * Ejecutar cola dentro del proceso del API (un solo VPS sin pm2 worker aparte).
 * Desactivar con EMBED_TASK_WORKER=false si ya corres `npm run worker` / worker:prod.
 */
export function shouldEmbedTaskWorkerInApi(): boolean {
  const v = (process.env.EMBED_TASK_WORKER ?? "true").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no");
}
