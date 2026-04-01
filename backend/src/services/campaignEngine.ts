import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueTaskDue, type RedisClient } from "../queues/redisClient.js";

type DaySlot = { day: number; enabled: boolean; start: string; end: string };

function parseSchedule(raw: unknown): DaySlot[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  return raw as DaySlot[];
}

/** Lunes=0 … Domingo=6 (UTC). */
function utcWeekdayMon0(d: Date): number {
  const sun0 = d.getUTCDay();
  return sun0 === 0 ? 6 : sun0 - 1;
}

function minutesUtc(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isWithinScheduleNow(schedule: DaySlot[] | null): boolean {
  if (!schedule?.length) return true;
  const now = new Date();
  const wd = utcWeekdayMon0(now);
  const slot = schedule.find((s) => s.day === wd);
  if (!slot?.enabled) return false;
  const sh = Number.parseInt(slot.start.split(":")[0]!, 10);
  const sm = Number.parseInt(slot.start.split(":")[1] ?? "0", 10);
  const eh = Number.parseInt(slot.end.split(":")[0]!, 10);
  const em = Number.parseInt(slot.end.split(":")[1] ?? "0", 10);
  const cur = minutesUtc(now);
  return cur >= sh * 60 + sm && cur <= eh * 60 + em;
}

/** Siguiente instante (ms) en que el calendario UTC permite ejecutar, a partir de `fromMs`. */
function nextAllowedRunTimeMs(schedule: DaySlot[] | null, fromMs: number): number {
  if (!schedule?.length) return fromMs;
  const from = new Date(fromMs);
  for (let addDays = 0; addDays < 8; addDays++) {
    const base = new Date(fromMs + addDays * 86400000);
    if (addDays > 0) base.setUTCHours(0, 0, 0, 0);
    const wd = utcWeekdayMon0(base);
    const slot = schedule.find((s) => s.day === wd);
    if (!slot?.enabled) continue;
    const sh = Number.parseInt(slot.start.split(":")[0]!, 10);
    const sm = Number.parseInt(slot.start.split(":")[1] ?? "0", 10);
    const eh = Number.parseInt(slot.end.split(":")[0]!, 10);
    const em = Number.parseInt(slot.end.split(":")[1] ?? "0", 10);
    const startM = sh * 60 + sm;
    const endM = eh * 60 + em;
    if (addDays === 0) {
      const cur = minutesUtc(from);
      if (cur < startM) {
        base.setUTCHours(sh, sm, 0, 0);
        return Math.max(base.getTime(), fromMs);
      }
      if (cur <= endM) return fromMs;
      continue;
    }
    base.setUTCHours(sh, sm, 0, 0);
    return base.getTime();
  }
  return fromMs + 3600000;
}

const ACTION_TO_FREQ_KEY: Record<string, string> = {
  send_message: "messages",
  send_message_open_profile: "messages",
  inmail: "inmails",
  connect: "connection_requests",
  comment_post: "ai_comments",
  like_post: "likes",
  visit_profile: "profile_visits",
  follow: "follow_lead",
  voice_note: "messages",
  reply_comment: "comments",
};

function dailyLimitForAction(freq: Record<string, number> | null | undefined, action: string): number {
  if (!freq || typeof freq !== "object") return 9999;
  const key = ACTION_TO_FREQ_KEY[action] ?? action;
  const v = freq[key];
  return typeof v === "number" && v > 0 ? v : 9999;
}

async function countTasksActionSince(
  sb: SupabaseClient,
  accountId: string,
  action: string,
  sinceIso: string
): Promise<number> {
  const { count, error } = await sb
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("action", action)
    .gte("created_at", sinceIso)
    .in("status", ["pending", "running", "completed"]);
  if (error) return 0;
  return count ?? 0;
}

/** Excluye leads ya en marcha o completados en otra campaña (índice de paso > 0 o completado). */
export async function filterLeadIdsSkipContactedOtherCampaigns(
  sb: SupabaseClient,
  campaignId: string,
  leadIds: string[]
): Promise<string[]> {
  if (!leadIds.length) return [];
  const { data: rows } = await sb
    .from("campaign_enrollments")
    .select("lead_id,status,current_step_index")
    .neq("campaign_id", campaignId)
    .in("lead_id", leadIds);
  const skip = new Set<string>();
  for (const r of rows ?? []) {
    const row = r as { lead_id: string; status: string; current_step_index: number };
    if (row.status === "completed" || (row.status === "active" && row.current_step_index > 0)) {
      skip.add(row.lead_id);
    }
  }
  return leadIds.filter((id) => !skip.has(id));
}

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
  wait: "wait",
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

  // Guard: no crear tarea duplicada si ya hay una pending/running para este enrollment
  const { count: existingCount } = await sb
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", enrollmentId)
    .in("status", ["pending", "running"]);
  if ((existingCount ?? 0) > 0) return false;

  const { data: campaign } = await sb
    .from("campaigns")
    .select("user_id, schedule_json, frequency_limits")
    .eq("id", en.campaign_id)
    .single();
  if (!campaign) return false;

  const schedule = parseSchedule(campaign.schedule_json);
  const freq = campaign.frequency_limits as Record<string, number> | null | undefined;

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
    .order("rotation_priority", { ascending: true })
    .limit(1);

  const accountId = accounts?.[0]?.id;
  if (!accountId) return false;

  const isWait = action === "wait";
  const { data: lead } = await sb.from("leads").select("*").eq("id", en.lead_id).single();
  if (!isWait && !lead) return false;

  let runAt = Math.max(new Date(en.next_run_at).getTime(), Date.now());
  if (schedule?.length && !isWithinScheduleNow(schedule)) {
    runAt = nextAllowedRunTimeMs(schedule, runAt);
  }

  if (!isWait) {
    const startUtc = new Date();
    startUtc.setUTCHours(0, 0, 0, 0);
    const sinceIso = startUtc.toISOString();
    const limit = dailyLimitForAction(freq, action);
    const used = await countTasksActionSince(sb, accountId, action, sinceIso);
    if (used >= limit) {
      const tomorrow = new Date(startUtc.getTime() + 86400000);
      runAt = Math.max(runAt, tomorrow.getTime());
      if (schedule?.length) runAt = nextAllowedRunTimeMs(schedule, runAt);
    }
  }

  const payload: Record<string, unknown> = {
    step_id: step.id,
    message_template: step.message_template,
    ...(lead
      ? {
          profile_url: lead.profile_url,
          lead_name: lead.name,
          lead_company: lead.company,
          lead_title: lead.title,
        }
      : {}),
  };

  const { data: task, error: e3 } = await sb
    .from("tasks")
    .insert({
      account_id: accountId,
      action,
      lead_id: lead?.id ?? en.lead_id,
      enrollment_id: enrollmentId,
      scheduled_at: new Date(runAt).toISOString(),
      status: "pending",
      payload,
    })
    .select("id, scheduled_at")
    .single();

  if (e3 || !task) return false;

  const scheduledMs = task.scheduled_at ? new Date(task.scheduled_at as string).getTime() : Date.now();
  await enqueueTaskDue(redis, task.id as string, scheduledMs);
  return true;
}

/**
 * Avanza el enrollment al siguiente paso usando el delay_hours configurado
 * en ese step (no necesita que el llamador lo calcule por separado).
 * Si no hay más pasos, marca el enrollment como completado.
 */
export async function advanceEnrollmentAfterStep(
  sb: SupabaseClient,
  redis: RedisClient,
  enrollmentId: string
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

  // Usa el delay_hours del próximo paso como espera antes de ejecutarlo
  const nextStep = steps[nextIdx] as Record<string, unknown>;
  const delayHours = typeof nextStep.delay_hours === "number" ? nextStep.delay_hours : 0;
  const nextRun = new Date(Date.now() + delayHours * 3600 * 1000).toISOString();

  await sb
    .from("campaign_enrollments")
    .update({
      current_step_index: nextIdx,
      next_run_at: nextRun,
    })
    .eq("id", enrollmentId);

  const scheduled = await scheduleEnrollmentStep(sb, redis, enrollmentId);
  if (!scheduled) {
    console.warn(`[campaignEngine] scheduleEnrollmentStep returned false para enrollment ${enrollmentId} (step ${nextIdx}) — enrollment avanzado pero sin tarea pendiente.`);
  }
}

/**
 * Marca el enrollment como fallido (tarea agotó reintentos).
 * Evita que la inscripción quede "huérfana" sin tarea pendiente.
 */
export async function failEnrollmentAfterDeadTask(
  sb: SupabaseClient,
  enrollmentId: string
): Promise<void> {
  await sb
    .from("campaign_enrollments")
    .update({ status: "failed" })
    .eq("id", enrollmentId)
    .eq("status", "active"); // solo si sigue activo; no pisar paused/completed
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

  // Escalonar los leads: cada uno arranca 30 minutos después del anterior
  // para nunca ejecutar dos leads en paralelo
  const STAGGER_MS = 30 * 60 * 1000;
  let leadIndex = 0;

  for (const leadId of leadIds) {
    // nextRun escalonado: lead 0 → ahora+firstDelay, lead 1 → ahora+firstDelay+30min, etc.
    const nextRun = new Date(Date.now() + firstDelayMs + leadIndex * STAGGER_MS).toISOString();
    leadIndex++;

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
        next_run_at: nextRun,
        crm_status: "in_campaign",
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
        crm_status: "in_campaign",
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
