import type { SupabaseClient } from "@supabase/supabase-js";

export type TaskWebhookEvent = "task.completed" | "task.failed";

function shouldSend(events: string[] | null | undefined, event: TaskWebhookEvent): boolean {
  if (events == null) return true;
  if (events.length === 0) return false;
  return events.includes(event);
}

export async function dispatchTaskWebhook(
  sb: SupabaseClient,
  taskId: string,
  event: TaskWebhookEvent
): Promise<void> {
  const { data: task } = await sb
    .from("tasks")
    .select("id, action, status, error_message, account_id, enrollment_id")
    .eq("id", taskId)
    .maybeSingle();
  if (!task?.account_id) return;

  const { data: acc } = await sb.from("linkedin_accounts").select("user_id").eq("id", task.account_id).maybeSingle();
  if (!acc?.user_id) return;

  const { data: prof } = await sb
    .from("profiles")
    .select("webhook_url, webhook_events")
    .eq("id", acc.user_id)
    .maybeSingle();

  const url = (prof?.webhook_url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return;

  if (!shouldSend(prof?.webhook_events as string[] | undefined, event)) return;

  const body = JSON.stringify({
    event,
    task: {
      id: task.id,
      action: task.action,
      account_id: task.account_id,
      enrollment_id: task.enrollment_id,
      status: task.status,
      error_message: task.error_message,
    },
  });

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "linkedin-saas-worker/1" },
      body,
      signal: ac.signal,
    });
  } catch {
    /* no rethrow: webhooks are best-effort */
  } finally {
    clearTimeout(t);
  }
}
