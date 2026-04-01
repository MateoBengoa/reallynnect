import "../lib/env.js";
import { getRedis, isMemoryRedis, resetMemoryBrowserSlotCounter } from "../queues/redisClient.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { processDueTasks } from "./taskRunner.js";

const INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 8000);

async function main() {
  const sb = getSupabaseAdmin();
  const redis = getRedis();
  if (isMemoryRedis(redis)) {
    resetMemoryBrowserSlotCounter();
    console.log("[worker] Cola en memoria: contador de navegadores reiniciado (evita slots colgados tras cierre brusco).");
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
