import "../lib/env.js";
import { getRedis } from "../queues/redisClient.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { prepareWorkerRuntime, startPeriodicTaskProcessing } from "./workerLoop.js";

const INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 8000);

async function main() {
  const sb = getSupabaseAdmin();
  const redis = getRedis();
  await prepareWorkerRuntime(sb, redis);

  console.log("automation worker started (proceso dedicado), poll", INTERVAL_MS, "ms");
  console.log(
    "[worker] .env desde paquete backend | headless=",
    process.env.PLAYWRIGHT_HEADLESS !== "false",
    "| channel=",
    process.env.PLAYWRIGHT_CHANNEL?.trim() || "(chromium embebido)"
  );

  startPeriodicTaskProcessing(sb, redis, "[worker]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
