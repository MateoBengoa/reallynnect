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

  const loop = async () => {
    try {
      await processDueTasks(sb, redis);
    } catch (e) {
      console.error("worker loop", e);
    }
  };

  await loop();
  setInterval(loop, INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
