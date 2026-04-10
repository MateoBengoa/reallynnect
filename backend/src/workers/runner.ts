import "../lib/env.js";
import { getRedis, isMemoryRedis, resetMemoryBrowserSlotCounter } from "../queues/redisClient.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { processDueTasks } from "./taskRunner.js";

const INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 8000);

async function main() {
  const sb = getSupabaseAdmin();
  const redis = getRedis();
  // Siempre resetear el contador de slots al arrancar — si el proceso anterior
  // murió sin liberar slots (crash, SIGKILL, pm2 restart) el contador Redis
  // queda elevado y ninguna tarea consigue slot hasta que se reinicia manualmente.
  if (isMemoryRedis(redis)) {
    resetMemoryBrowserSlotCounter();
  } else {
    await (redis as import("ioredis").Redis).set(
      (await import("../queues/redisClient.js")).BROWSER_SLOT_KEY,
      "0"
    ).catch(() => {});
  }
  console.log("[worker] Contador de slots de navegador reiniciado a 0.");

  // Las acciones cortas (verify_session, session_check, poll_comments) que quedaron en
  // «running» al morir el worker anterior se resetean inmediatamente a pending, en lugar
  // de esperar los 120-300s del stale poll. Esto evita que verify_session quede bloqueada
  // varios minutos cada vez que el worker se reinicia.
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

  console.log("automation worker started, poll", INTERVAL_MS, "ms");
  console.log(
    "[worker] .env desde paquete backend | headless=",
    process.env.PLAYWRIGHT_HEADLESS !== "false",
    "| channel=",
    process.env.PLAYWRIGHT_CHANNEL?.trim() || "(chromium embebido)"
  );

  let consecutiveErrors = 0;

  const loop = async () => {
    try {
      await processDueTasks(sb, redis);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      const backoffMs = Math.min(60_000, INTERVAL_MS * 2 ** Math.min(consecutiveErrors - 1, 5));
      console.error(`[worker] loop error #${consecutiveErrors} (backoff ${backoffMs}ms):`, e instanceof Error ? e.message : e);
      if (consecutiveErrors >= 10) {
        console.error("[worker] 10 errores consecutivos — posible problema con DB/Redis. Esperando backoff máximo.");
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  };

  await loop();
  setInterval(loop, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
