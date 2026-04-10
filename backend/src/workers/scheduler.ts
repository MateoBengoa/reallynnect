import "../lib/env.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { getRedis, enqueueTaskDue, trySchedulerLock } from "../queues/redisClient.js";

const WARMUP_HOURS = Number(process.env.WARMUP_INTERVAL_HOURS ?? 18);
const POLL_MS = Number(process.env.SCHEDULER_POLL_MS ?? 3_600_000);

/** Mínimo entre encolados de poll_comments por cuenta (LinkedIn: menos ruido = menos riesgo). Por defecto ~2 veces/día. */
const rawKeywordPollLockSec = Number(process.env.SCHEDULER_KEYWORD_POLL_LOCK_SEC ?? 43_200);
const KEYWORD_POLL_LOCK_SEC =
  Number.isFinite(rawKeywordPollLockSec) && rawKeywordPollLockSec >= 3600
    ? Math.floor(rawKeywordPollLockSec)
    : 43_200;

async function hasPendingTask(
  sb: ReturnType<typeof getSupabaseAdmin>,
  accountId: string,
  action: string
): Promise<boolean> {
  const { data } = await sb
    .from("tasks")
    .select("id")
    .eq("account_id", accountId)
    .eq("action", action)
    .in("status", ["pending", "running"])
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function scheduleWarmups(sb: ReturnType<typeof getSupabaseAdmin>, redis: ReturnType<typeof getRedis>) {
  const { data: accounts } = await sb
    .from("linkedin_accounts")
    .select("id, last_warmup_at")
    .eq("connection_status", "active");

  const cutoff = Date.now() - WARMUP_HOURS * 3600 * 1000;

  for (const a of accounts ?? []) {
    const last = a.last_warmup_at ? new Date(a.last_warmup_at).getTime() : 0;
    if (last > cutoff) continue;
    if (await hasPendingTask(sb, a.id, "warmup_feed")) continue;

    const { data: task } = await sb
      .from("tasks")
      .insert({
        account_id: a.id,
        action: "warmup_feed",
        scheduled_at: new Date().toISOString(),
        status: "pending",
        payload: {},
      })
      .select("id, scheduled_at")
      .single();
    if (task) await enqueueTaskDue(redis, task.id, new Date(task.scheduled_at).getTime());
  }
}

async function scheduleKeywordPolls(sb: ReturnType<typeof getSupabaseAdmin>, redis: ReturnType<typeof getRedis>) {
  const pollsOn = (process.env.SCHEDULER_KEYWORD_POLLS ?? "true").toLowerCase();
  if (pollsOn === "false" || pollsOn === "0" || pollsOn === "no") return;

  const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("connection_status", "active");

  for (const a of accounts ?? []) {
    const bundleLock = `sched:keyword_polls:${a.id}`;
    const ok = await trySchedulerLock(redis, bundleLock, KEYWORD_POLL_LOCK_SEC);
    if (!ok) continue;

    if (await hasPendingTask(sb, a.id, "poll_comments")) continue;

    const { data: task } = await sb
      .from("tasks")
      .insert({
        account_id: a.id,
        action: "poll_comments",
        scheduled_at: new Date().toISOString(),
        status: "pending",
        payload: {},
      })
      .select("id, scheduled_at")
      .single();
    if (task) await enqueueTaskDue(redis, task.id, new Date(task.scheduled_at).getTime());
  }
}

async function main() {
  const sb = getSupabaseAdmin();
  const redis = getRedis();
  console.log(
    "scheduler started, interval ms",
    POLL_MS,
    "keyword_poll_lock_sec",
    KEYWORD_POLL_LOCK_SEC
  );

  const tick = async () => {
    try {
      await scheduleWarmups(sb, redis);
      await scheduleKeywordPolls(sb, redis);
    } catch (e) {
      console.error("scheduler", e);
    }
  };

  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
