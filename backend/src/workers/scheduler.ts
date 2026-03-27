import "../lib/env.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { getRedis, enqueueTaskDue, trySchedulerLock } from "../queues/redisClient.js";

const WARMUP_HOURS = Number(process.env.WARMUP_INTERVAL_HOURS ?? 18);
const POLL_MS = Number(process.env.SCHEDULER_POLL_MS ?? 3_600_000);

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
    for (const action of ["poll_messages", "poll_comments"] as const) {
      const lockKey = `sched:${action}:${a.id}`;
      const ok = await trySchedulerLock(redis, lockKey, 2700);
      if (!ok) continue;
      if (await hasPendingTask(sb, a.id, action)) continue;

      const { data: task } = await sb
        .from("tasks")
        .insert({
          account_id: a.id,
          action,
          scheduled_at: new Date().toISOString(),
          status: "pending",
          payload: {},
        })
        .select("id, scheduled_at")
        .single();
      if (task) await enqueueTaskDue(redis, task.id, new Date(task.scheduled_at).getTime());
    }
  }
}

async function main() {
  const sb = getSupabaseAdmin();
  const redis = getRedis();
  console.log("scheduler started, interval ms", POLL_MS);

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
