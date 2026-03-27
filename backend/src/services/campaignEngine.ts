import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueTaskDue, type RedisClient } from "../queues/redisClient.js";

/**
 * Limpia cola abierta de la inscripción y reencola «running» como pending.
 * Devuelve cuántas tareas quedaron listas para el worker (reencoladas).
 */
async function resetOpenTasksForEnrollment(
  sb: SupabaseClient,
  redis: RedisClient,
  enrollmentId: string
): Promise<number> {
  const nowIso = new Date().toISOString();
  await sb.from("tasks").delete().eq("enrollment_id", enrollmentId).in("status", ["pending", "dead"]);

  const { data: runningRows } = await sb
    .from("tasks")
    .select("id")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "running");

  let n = 0;
  for (const r of runningRows ?? []) {
    await sb
      .from("tasks")
      .update({
        status: "pending",
        scheduled_at: nowIso,
        locked_at: null,
        error_message: "requeued_campaign_start",
      })
      .eq("id", r.id);
    await enqueueTaskDue(redis, r.id, Date.now());
    n++;
  }
  return n;
}

const STEP_TO_ACTION: Record<string, string> = {
  visit_profile: "visit_profile",
  connect: "connect",
  send_message: "send_message",
  send_message_open_profile: "send_message_open_profile",
  follow: "follow",
  like_post: "like_post",
  comment_post: "comment_post",
  voice_note: "voice_note",
  reply_comment: "reply_comment",
  inmail: "inmail",
};

/** Devuelve true si se insertó una tarea pendiente. */
export async function scheduleEnrollmentStep(
  sb: SupabaseClient,
  redis: RedisClient,
  enrollmentId: string
): Promise<boolean> {
  const { data: en, error: e1 } = await sb
    .from("campaign_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .single();

  if (e1 || !en || en.status !== "active") return false;

  const { data: campaign } = await sb.from("campaigns").select("user_id").eq("id", en.campaign_id).single();
  if (!campaign) return false;

  const { data: steps, error: e2 } = await sb
    .from("campaign_steps")
    .select("*")
    .eq("campaign_id", en.campaign_id)
    .order("step_order", { ascending: true });

  if (e2 || !steps?.length) return false;

  const idx = en.current_step_index;
  if (idx >= steps.length) {
    await sb.from("campaign_enrollments").update({ status: "completed" }).eq("id", enrollmentId);
    return false;
  }

  const step = steps[idx];
  const action = STEP_TO_ACTION[step.step_type] ?? step.step_type;

  const { data: accounts } = await sb
    .from("linkedin_accounts")
    .select("id")
    .eq("user_id", campaign.user_id)
    .eq("connection_status", "active")
    .limit(1);

  const accountId = accounts?.[0]?.id;
  const { data: lead } = await sb.from("leads").select("*").eq("id", en.lead_id).single();
  if (!accountId || !lead) return false;

  const runAt = Math.max(new Date(en.next_run_at).getTime(), Date.now());
  const payload: Record<string, unknown> = {
    step_id: step.id,
    message_template: step.message_template,
    profile_url: lead.profile_url,
    lead_name: lead.name,
    lead_company: lead.company,
    lead_title: lead.title,
  };

  const { data: task, error: e3 } = await sb
    .from("tasks")
    .insert({
      account_id: accountId,
      action,
      lead_id: lead.id,
      enrollment_id: enrollmentId,
      scheduled_at: new Date(runAt).toISOString(),
      status: "pending",
      payload,
    })
    .select("id, scheduled_at")
    .single();

  if (e3 || !task) return false;

  await enqueueTaskDue(redis, task.id, new Date(task.scheduled_at).getTime());
  return true;
}

export async function advanceEnrollmentAfterStep(
  sb: SupabaseClient,
  redis: RedisClient,
  enrollmentId: string,
  delayHoursBeforeNextStep: number
): Promise<void> {
  const { data: en } = await sb.from("campaign_enrollments").select("*").eq("id", enrollmentId).single();
  if (!en) return;

  const { data: steps } = await sb
    .from("campaign_steps")
    .select("*")
    .eq("campaign_id", en.campaign_id)
    .order("step_order", { ascending: true });

  if (!steps?.length) return;

  const nextIdx = en.current_step_index + 1;
  if (nextIdx >= steps.length) {
    await sb
      .from("campaign_enrollments")
      .update({ status: "completed", current_step_index: nextIdx })
      .eq("id", enrollmentId);
    return;
  }

  const nextRun = new Date(Date.now() + delayHoursBeforeNextStep * 3600 * 1000).toISOString();

  await sb
    .from("campaign_enrollments")
    .update({
      current_step_index: nextIdx,
      next_run_at: nextRun,
    })
    .eq("id", enrollmentId);

  await scheduleEnrollmentStep(sb, redis, enrollmentId);
}

export type CreateEnrollmentsResult = {
  /** Tareas `pending` creadas o reencoladas en esta llamada. */
  tasks_scheduled: number;
  /** Inscripciones nuevas en BD. */
  enrollments_new: number;
  /** Inscripciones que ya existían y se reactivaron / reencolaron. */
  enrollments_existing: number;
};

export async function createEnrollmentsAndSchedule(
  sb: SupabaseClient,
  redis: RedisClient,
  campaignId: string,
  leadIds: string[]
): Promise<CreateEnrollmentsResult> {
  const result: CreateEnrollmentsResult = {
    tasks_scheduled: 0,
    enrollments_new: 0,
    enrollments_existing: 0,
  };

  const { data: firstStep } = await sb
    .from("campaign_steps")
    .select("delay_hours")
    .eq("campaign_id", campaignId)
    .order("step_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  const firstDelayMs = (firstStep?.delay_hours ?? 0) * 3600 * 1000;
  const nextRun = new Date(Date.now() + firstDelayMs).toISOString();

  for (const leadId of leadIds) {
    const { data: existing } = await sb
      .from("campaign_enrollments")
      .select("id")
      .eq("campaign_id", campaignId)
      .eq("lead_id", leadId)
      .maybeSingle();

    if (existing) {
      result.enrollments_existing++;

      const { data: enRow } = await sb
        .from("campaign_enrollments")
        .select("id, status, current_step_index")
        .eq("id", existing.id)
        .single();

      const { data: stepRows } = await sb
        .from("campaign_steps")
        .select("id")
        .eq("campaign_id", campaignId)
        .order("step_order", { ascending: true });
      const nSteps = stepRows?.length ?? 0;

      const mustRestartFromBeginning =
        enRow &&
        (enRow.status === "completed" ||
          (typeof enRow.current_step_index === "number" && nSteps > 0 && enRow.current_step_index >= nSteps));

      const enPatch: Record<string, unknown> = {
        status: "active",
        next_run_at: new Date().toISOString(),
      };
      if (mustRestartFromBeginning) {
        enPatch.current_step_index = 0;
      }
      await sb.from("campaign_enrollments").update(enPatch).eq("id", existing.id);

      const reopened = await resetOpenTasksForEnrollment(sb, redis, existing.id);
      result.tasks_scheduled += reopened;
      if (reopened > 0) continue;

      const ok = await scheduleEnrollmentStep(sb, redis, existing.id);
      if (ok) result.tasks_scheduled++;
      continue;
    }

    const { data: row, error } = await sb
      .from("campaign_enrollments")
      .insert({
        campaign_id: campaignId,
        lead_id: leadId,
        current_step_index: 0,
        next_run_at: nextRun,
        status: "active",
      })
      .select("id")
      .single();

    if (error || !row) continue;
    result.enrollments_new++;
    const ok = await scheduleEnrollmentStep(sb, redis, row.id);
    if (ok) result.tasks_scheduled++;
  }

  return result;
}
