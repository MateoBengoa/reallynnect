import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueTaskDue, type RedisClient } from "../queues/redisClient.js";

export async function enqueueTask(
  sb: SupabaseClient,
  redis: RedisClient,
  row: {
    account_id: string;
    action: string;
    lead_id?: string | null;
    enrollment_id?: string | null;
    scheduled_at?: string;
    payload?: Record<string, unknown>;
  }
): Promise<string | null> {
  const { data, error } = await sb
    .from("tasks")
    .insert({
      account_id: row.account_id,
      action: row.action,
      lead_id: row.lead_id ?? null,
      enrollment_id: row.enrollment_id ?? null,
      scheduled_at: row.scheduled_at ?? new Date().toISOString(),
      status: "pending",
      payload: row.payload ?? {},
    })
    .select("id, scheduled_at")
    .single();

  if (error || !data) return null;
  await enqueueTaskDue(redis, data.id, new Date(data.scheduled_at).getTime());
  return data.id;
}
