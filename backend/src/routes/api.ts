import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getQueueMode } from "../queues/redisClient.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto.js";
import {
  createEnrollmentsAndSchedule,
  filterLeadIdsSkipContactedOtherCampaigns,
  scheduleEnrollmentStep,
} from "../services/campaignEngine.js";
import { generateImageBytes, generatePost } from "../services/gemini.js";
import { pickProxyForAccount } from "../services/proxyAssign.js";
import { enqueueTask } from "../services/taskQueue.js";

const proxyBody = z.object({
  host: z.string(),
  port: z.number(),
  username: z.string().optional(),
  password: z.string().optional(),
});

const liAccountBody = z.object({
  li_at: z.string().min(10),
  proxy_id: z.string().uuid().optional(),
});

/** Acepta valor puro, `li_at=...` o un fragmento tipo Cookie `...; li_at=...;`. */
function normalizeLiAt(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  const fromSetCookie = /(?:^|;\s*)li_at=([^;]+)/i.exec(s);
  if (fromSetCookie) {
    try {
      return decodeURIComponent(fromSetCookie[1]!.trim());
    } catch {
      return fromSetCookie[1]!.trim();
    }
  }
  s = s.replace(/^li_at\s*=\s*/i, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.trim();
}

const WORKER_ACTIONS_IMPLEMENTED = new Set([
  "verify_session",
  "session_check",
  "sync_profile",
  "warmup_feed",
  "visit_profile",
  "follow",
  "like_post",
  "comment_post",
  "connect",
  "send_message",
  "send_message_open_profile",
  "voice_note",
  "reply_comment",
  "inmail",
  "publish_post",
  "poll_messages",
  "poll_comments",
  "reply_dm",
  "sync_inbox",
  "sync_inbox_thread",
  "sync_linkedin_posts",
  "import_leads",
  "sync_lead_photo",
  "batch_sync_lead_photos",
]);

export async function registerApiRoutes(app: FastifyInstance) {
  const sb = app.sb;
  const redis = app.redis;

  /**
   * Resumen para depurar por qué no avanzan tareas / campañas (requiere sesión).
   * No expone secretos; solo flags y conteos.
   */
  app.get("/debug/diagnostics", async (req) => {
    const userId = req.userId!;
    const warnings: string[] = [];
    const nowIso = new Date().toISOString();

    const cookieKey = process.env.COOKIE_ENCRYPTION_KEY ?? "";
    const envSummary = {
      queue_mode: getQueueMode(),
      supabase_url_configured: Boolean(process.env.SUPABASE_URL),
      cookie_encryption_key_ok: cookieKey.length >= 32,
      gemini_configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      playwright_headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
      worker_poll_ms: Number(process.env.WORKER_POLL_MS ?? 8000),
      task_stale_running_minutes: Number(process.env.TASK_STALE_RUNNING_MINUTES ?? 45),
      linkedin_fast_automation: process.env.LINKEDIN_FAST_AUTOMATION === "true",
    };

    if (getQueueMode() === "memory") {
      warnings.push(
        "Cola en memoria: API, worker y scheduler tienen cada uno su propia cola en RAM. Las tareas pendientes se descubren igualmente por consulta a Supabase; si algo dependiera solo del ZSET en otro proceso, no coincidiría."
      );
    }
    if (!envSummary.cookie_encryption_key_ok) {
      warnings.push("COOKIE_ENCRYPTION_KEY debería tener al menos 32 caracteres para cifrar cookies.");
    }

    const { data: accounts, error: accErr } = await sb
      .from("linkedin_accounts")
      .select("id, connection_status, session_verified_at, paused_until")
      .eq("user_id", userId);
    if (accErr) warnings.push(`linkedin_accounts: ${accErr.message}`);

    const accountIds = (accounts ?? []).map((a) => a.id);
    const byStatus: Record<string, number> = {};
    for (const a of accounts ?? []) {
      const s = a.connection_status ?? "unknown";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }

    const hasActiveLi = (accounts ?? []).some((a) => a.connection_status === "active");
    if (!hasActiveLi) {
      warnings.push(
        "No hay cuenta LinkedIn en estado «active». La verificación debe completarse (tarea verify_session) antes de iniciar campañas."
      );
    }

    let tasks_locked_at_ok = true;
    if (accountIds.length) {
      const probe = await sb.from("tasks").select("id, locked_at").in("account_id", accountIds).limit(1).maybeSingle();
      if (
        probe.error?.message &&
        (probe.error.message.includes("locked_at") || probe.error.message.includes("schema cache"))
      ) {
        tasks_locked_at_ok = false;
        warnings.push(
          "Falta la columna tasks.locked_at (migración 003). El worker tiene fallback sin locked_at; la recuperación de tareas «running» colgadas es menos fiable."
        );
      }
    }

    const taskCounts: Record<string, number> = {};
    const statuses = ["pending", "running", "completed", "dead"] as const;
    if (accountIds.length) {
      for (const st of statuses) {
        const { count, error } = await sb
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .in("account_id", accountIds)
          .eq("status", st);
        if (error) warnings.push(`tasks count ${st}: ${error.message}`);
        else taskCounts[st] = count ?? 0;
      }
    }

    let pending_due_now = 0;
    if (accountIds.length) {
      const { count, error } = await sb
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .in("account_id", accountIds)
        .eq("status", "pending")
        .lte("scheduled_at", nowIso);
      if (error) warnings.push(`pending due: ${error.message}`);
      else pending_due_now = count ?? 0;
    }

    let recentTasks: unknown[] = [];
    if (accountIds.length) {
      const { data, error } = await sb
        .from("tasks")
        .select("id, status, action, error_message, scheduled_at, attempts, locked_at, created_at")
        .in("account_id", accountIds)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) warnings.push(`tasks recent: ${error.message}`);
      else recentTasks = data ?? [];
    }

    const unknownActions = new Set<string>();
    for (const row of recentTasks as { action?: string; error_message?: string | null }[]) {
      const em = row.error_message ?? "";
      const m = em.match(/^unknown_action:(.+)$/);
      if (m) unknownActions.add(m[1]!);
    }
    if (unknownActions.size) {
      warnings.push(
        `Tareas con error unknown_action (acción no reconocida por el worker): ${[...unknownActions].join(", ")}.`
      );
    }

    const { data: userCampaigns } = await sb.from("campaigns").select("id").eq("user_id", userId);
    const campaignIds = (userCampaigns ?? []).map((c) => c.id);
    let stepsSample: { step_type: string }[] = [];
    if (campaignIds.length) {
      const { data: st } = await sb.from("campaign_steps").select("step_type").in("campaign_id", campaignIds).limit(200);
      stepsSample = st ?? [];
    }
    const stepTypes = new Set(stepsSample.map((r) => r.step_type));
    for (const st of stepTypes) {
      if (!WORKER_ACTIONS_IMPLEMENTED.has(st)) {
        warnings.push(
          `Tienes un paso de campaña «${st}» configurado; el worker aún no implementa esa acción (fallará con unknown_action).`
        );
      }
    }

    let enrollRows: { status: string }[] = [];
    if (campaignIds.length) {
      const { data: en } = await sb.from("campaign_enrollments").select("status").in("campaign_id", campaignIds);
      enrollRows = en ?? [];
    }
    const enByStatus: Record<string, number> = {};
    for (const r of enrollRows) {
      const s = r.status;
      enByStatus[s] = (enByStatus[s] ?? 0) + 1;
    }

    return {
      time: nowIso,
      env: envSummary,
      schema: { tasks_locked_at_column_ok: tasks_locked_at_ok },
      linkedin_accounts: { count: accounts?.length ?? 0, by_connection_status: byStatus },
      tasks: { counts_by_status: taskCounts, pending_scheduled_ready: pending_due_now },
      campaign_enrollments_by_status: enByStatus,
      recent_tasks: recentTasks,
      warnings,
    };
  });

  app.get("/me", async (req) => {
    const { data } = await sb.from("profiles").select("*").eq("id", req.userId!).single();
    return { profile: data };
  });

  app.patch("/me", async (req, reply) => {
    const schema = z.object({
      webhook_url: z.string().max(4000).optional().nullable(),
      webhook_events: z.array(z.enum(["task.completed", "task.failed"])).optional(),
      exclude_connect_messages_from_reply_rate: z.boolean().optional(),
    });
    const body = schema.parse(req.body ?? {});
    const patch: Record<string, unknown> = {};
    if ("webhook_url" in body) {
      const u = body.webhook_url?.trim() ?? "";
      patch.webhook_url = u.length ? u : null;
    }
    if (body.webhook_events !== undefined) patch.webhook_events = body.webhook_events;
    if (body.exclude_connect_messages_from_reply_rate !== undefined) {
      patch.exclude_connect_messages_from_reply_rate = body.exclude_connect_messages_from_reply_rate;
    }
    if (!Object.keys(patch).length) return reply.status(400).send({ error: "Nada que actualizar" });
    const { data, error } = await sb.from("profiles").update(patch).eq("id", req.userId!).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { profile: data };
  });

  app.get("/proxies", async (req) => {
    const { data, error } = await sb.from("proxies").select("id,host,port,username,status,last_used,created_at");
    if (error) throw error;
    return {
      proxies: (data ?? []).map((p) => ({
        ...p,
        username: p.username ? maskSecret(p.username) : null,
      })),
    };
  });

  app.post("/proxies", async (req, reply) => {
    const body = proxyBody.parse(req.body);
    const row = {
      host: body.host,
      port: body.port,
      username: body.username ?? null,
      password: body.password ? encryptSecret(body.password) : null,
      status: "active" as const,
    };
    const { data, error } = await sb.from("proxies").insert(row).select("id").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { id: data!.id };
  });

  app.get("/linkedin-accounts", async (req) => {
    const { data, error } = await sb
      .from("linkedin_accounts")
      .select(
        "id,proxy_id,warmup_state,softban_status,paused_until,connection_status,last_warmup_at,created_at,li_display_name,li_headline,li_photo_url,session_verified_at,daily_message_budget,daily_visit_budget,daily_connect_budget,rotation_priority"
      )
      .eq("user_id", req.userId!);
    if (error) throw error;
    return { accounts: data ?? [] };
  });

  app.post("/linkedin-accounts", async (req, reply) => {
    const body = liAccountBody.parse(req.body);
    const liAt = normalizeLiAt(body.li_at);
    if (liAt.length < 10) return reply.status(400).send({ error: "li_at inválido o demasiado corto tras normalizar el pegado." });
    const proxyId = body.proxy_id ?? (await pickProxyForAccount(sb));
    const enc = encryptSecret(liAt);
    const { data, error } = await sb
      .from("linkedin_accounts")
      .insert({
        user_id: req.userId!,
        li_at_cookie: enc,
        proxy_id: proxyId ?? null,
        connection_status: "pending",
      })
      .select("id")
      .single();
    if (error) return reply.status(400).send({ error: error.message });

    const taskId = await enqueueTask(sb, redis, {
      account_id: data!.id,
      action: "verify_session",
      payload: {},
    });
    if (!taskId) {
      await sb.from("linkedin_accounts").delete().eq("id", data!.id);
      return reply.status(500).send({ error: "No se pudo crear la tarea de verificación. Revisa logs del backend y la tabla tasks en Supabase." });
    }
    return { id: data!.id, verify_task_id: taskId };
  });

  app.patch("/linkedin-accounts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      daily_message_budget: z.number().int().positive().nullable().optional(),
      daily_visit_budget: z.number().int().positive().nullable().optional(),
      daily_connect_budget: z.number().int().positive().nullable().optional(),
      rotation_priority: z.number().int().optional(),
      li_at: z.string().min(10).optional(),
      proxy_id: z.string().uuid().nullable().optional(),
    });
    const body = schema.parse(req.body ?? {});
    const updates: Record<string, unknown> = {};
    if (body.daily_message_budget !== undefined) updates.daily_message_budget = body.daily_message_budget;
    if (body.daily_visit_budget !== undefined) updates.daily_visit_budget = body.daily_visit_budget;
    if (body.daily_connect_budget !== undefined) updates.daily_connect_budget = body.daily_connect_budget;
    if (body.rotation_priority !== undefined) updates.rotation_priority = body.rotation_priority;
    if (body.li_at !== undefined) {
      const liAt = normalizeLiAt(body.li_at);
      if (liAt.length < 10) return reply.status(400).send({ error: "li_at inválido o demasiado corto tras normalizar el pegado." });
      updates.li_at_cookie = encryptSecret(liAt);
      updates.connection_status = "pending";
    }
    if (body.proxy_id !== undefined) updates.proxy_id = body.proxy_id;
    if (!Object.keys(updates).length) return reply.status(400).send({ error: "Nada que actualizar" });
    const { data: row } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!row) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const { data, error } = await sb.from("linkedin_accounts").update(updates).eq("id", id).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    let verify_task_id: string | null = null;
    if (body.li_at !== undefined) {
      verify_task_id = await enqueueTask(sb, redis, {
        account_id: id,
        action: "verify_session",
        payload: {},
      });
    }
    return { account: data, verify_task_id };
  });

  app.delete("/linkedin-accounts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { error } = await sb.from("linkedin_accounts").delete().eq("id", id).eq("user_id", req.userId!);
    if (error) return reply.status(400).send({ error: error.message });
    return { ok: true };
  });

  /** Encola scraping de /in/me (nombre, titular, foto) y actualiza session_verified_at. */
  app.post("/linkedin-accounts/:id/sync-profile", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: row, error: qErr } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (qErr || !row) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const taskId = await enqueueTask(sb, redis, {
      account_id: id,
      action: "sync_profile",
      payload: {},
    });
    if (!taskId) {
      return reply.status(500).send({ error: "No se pudo encolar la sincronización" });
    }
    return { ok: true, task_id: taskId };
  });

  /** Encola scraping de actividad reciente en LinkedIn → filas `posts` (publicados). */
  app.post("/linkedin-accounts/:id/sync-posts", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: row, error: qErr } = await sb
      .from("linkedin_accounts")
      .select("id, connection_status")
      .eq("id", id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (qErr || !row) return reply.status(404).send({ error: "Cuenta no encontrada" });
    if (row.connection_status !== "active") {
      return reply.status(400).send({
        error: "La sesión LinkedIn debe estar activa. Actualiza la cookie o espera la verificación.",
      });
    }
    const taskId = await enqueueTask(sb, redis, {
      account_id: id,
      action: "sync_linkedin_posts",
      payload: {},
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar la sincronización de posts" });
    return { ok: true, task_id: taskId };
  });

  app.get("/leads", async (req, reply) => {
    const { data, error } = await sb
      .from("leads")
      .select("*")
      .eq("user_id", req.userId!)
      .order("created_at", { ascending: false });
    if (error) {
      req.log.warn({ err: error }, "GET /leads");
      return reply.status(500).send({
        error: "No se pudo cargar leads",
        detail: error.message,
        code: (error as { code?: string }).code,
      });
    }
    return { leads: data ?? [] };
  });

  /**
   * Rellena photo_url desde la página pública del perfil (Microlink + og:image), sin cookies.
   */
  app.post("/leads/fetch-photos", async (req, reply) => {
    const schema = z.object({
      max: z.number().int().min(1).max(80).optional().default(40),
      concurrency: z.number().int().min(1).max(8).optional().default(4),
    });
    const body = schema.parse(req.body ?? {});
    const userId = req.userId!;

    // 1) Limpiar photo_url que sean placeholders conocidos (LinkedIn ghost, unavatar defaults)
    const { looksLikeRealPersonPhoto } = await import("../services/linkedinLeadPhoto.js");
    const { data: withPhoto } = await sb
      .from("leads")
      .select("id, photo_url")
      .eq("user_id", userId)
      .not("photo_url", "is", null)
      .ilike("profile_url", "%linkedin.com/in/%")
      .limit(500);
    let cleaned = 0;
    for (const row of withPhoto ?? []) {
      const url = String(row.photo_url ?? "").trim();
      if (url && !looksLikeRealPersonPhoto(url)) {
        await sb.from("leads").update({ photo_url: null }).eq("id", row.id).eq("user_id", userId);
        cleaned++;
      }
    }
    if (cleaned) console.log(`[fetch-photos] Limpiadas ${cleaned} fotos placeholder`);

    // 2) Resolver fotos para leads sin photo_url
    const { data: rows, error } = await sb
      .from("leads")
      .select("id, profile_url")
      .eq("user_id", userId)
      .is("photo_url", null)
      .ilike("profile_url", "%linkedin.com/in/%")
      .limit(body.max);
    if (error) throw error;
    const list = (rows ?? []) as { id: string; profile_url: string }[];
    if (!list.length) return { updated: 0, attempted: 0, cleaned };

    const { resolveLinkedInProfilePhotoUrl } = await import("../services/linkedinLeadPhoto.js");

    async function runOne(row: { id: string; profile_url: string }): Promise<boolean> {
      const url = await resolveLinkedInProfilePhotoUrl(row.profile_url, 7000);
      if (!url) return false;
      const { error: uErr } = await sb.from("leads").update({ photo_url: url }).eq("id", row.id).eq("user_id", userId);
      return !uErr;
    }

    let updated = 0;
    const conc = body.concurrency;
    for (let i = 0; i < list.length; i += conc) {
      const chunk = list.slice(i, i + conc);
      const okFlags = await Promise.all(chunk.map((r) => runOne(r)));
      updated += okFlags.filter(Boolean).length;
    }

    return { updated, attempted: list.length, cleaned };
  });

  /**
   * Encola visita al perfil LinkedIn del lead (misma sesión que el worker) para guardar photo_url desde el DOM.
   * Cuenta contra el cupo diario de "visit" de la cuenta.
   */
  app.post("/leads/:id/sync-photo", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: lead } = await sb.from("leads").select("id, profile_url, user_id").eq("id", id).eq("user_id", req.userId!).maybeSingle();
    if (!lead) return reply.status(404).send({ error: "Lead no encontrado" });
    const pu = String(lead.profile_url ?? "").trim().toLowerCase();
    if (!pu.includes("linkedin.com") || !pu.includes("/in/")) {
      return reply.status(400).send({ error: "El lead necesita una profile_url de perfil LinkedIn (/in/...)" });
    }
    const { data: activeLi } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", req.userId!)
      .eq("connection_status", "active")
      .order("rotation_priority", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!activeLi) {
      return reply.status(400).send({
        error: "Necesitas una cuenta LinkedIn activa para sincronizar la foto desde el perfil.",
      });
    }
    const taskId = await enqueueTask(sb, redis, {
      account_id: activeLi.id as string,
      action: "sync_lead_photo",
      lead_id: id,
      enrollment_id: null,
      payload: { profile_url: lead.profile_url },
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar la tarea" });
    return { ok: true, task_id: taskId };
  });

  /**
   * Una sola tarea worker: una sesión Playwright y varios perfiles seguidos (photo_url desde el DOM).
   */
  app.post("/leads/batch-sync-photos", async (req, reply) => {
    const schema = z.object({
      max: z.number().int().min(1).max(80).optional().default(40),
      only_missing: z.boolean().optional().default(true),
      lead_ids: z.array(z.string().uuid()).max(200).optional(),
    });
    const body = schema.parse(req.body ?? {});
    const userId = req.userId!;

    const { data: activeLi } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("connection_status", "active")
      .order("rotation_priority", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!activeLi) {
      return reply.status(400).send({
        error: "Necesitas una cuenta LinkedIn activa para sincronizar fotos desde el perfil.",
      });
    }

    let qb = sb
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .ilike("profile_url", "%linkedin.com%")
      .ilike("profile_url", "%/in/%")
      .order("created_at", { ascending: true });
    if (body.only_missing) {
      qb = qb.is("photo_url", null);
    }
    if (body.lead_ids?.length) {
      qb = qb.in("id", body.lead_ids);
    }
    const { data: rows, error } = await qb.limit(body.max);
    if (error) throw error;
    const ids = (rows ?? []).map((r: { id: string }) => r.id);
    if (!ids.length) {
      return { ok: true, task_id: null, queued: 0 };
    }

    const taskId = await enqueueTask(sb, redis, {
      account_id: activeLi.id as string,
      action: "batch_sync_lead_photos",
      lead_id: null,
      enrollment_id: null,
      payload: { lead_ids: ids },
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar la tarea" });
    return { ok: true, task_id: taskId, queued: ids.length };
  });

  app.post("/leads", async (req, reply) => {
    const schema = z.object({
      profile_url: z.string().url(),
      name: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      headline: z.string().optional(),
      photo_url: z.string().optional(),
      location: z.string().optional(),
      website: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const { data, error } = await sb
      .from("leads")
      .insert({ ...body, user_id: req.userId! })
      .select("*")
      .single();
    if (error) return reply.status(400).send({ error: error.message });
    return { lead: data };
  });

  app.patch("/leads/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      name: z.string().optional().nullable(),
      company: z.string().optional().nullable(),
      title: z.string().optional().nullable(),
      headline: z.string().optional().nullable(),
      photo_url: z.string().optional().nullable(),
      location: z.string().optional().nullable(),
      website: z.string().optional().nullable(),
      email: z.string().optional().nullable(),
      phone: z.string().optional().nullable(),
      is_blacklisted: z.boolean().optional(),
    });
    const body = schema.parse(req.body ?? {});
    const { data: row } = await sb.from("leads").select("id").eq("id", id).eq("user_id", req.userId!).maybeSingle();
    if (!row) return reply.status(404).send({ error: "Not found" });
    const { data, error } = await sb.from("leads").update(body).eq("id", id).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { lead: data };
  });

  app.post("/leads/import", async (req, reply) => {
    const rowSchema = z.object({
      profile_url: z.string().url(),
      name: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      headline: z.string().optional(),
      photo_url: z.string().optional(),
      location: z.string().optional(),
      source: z.string().max(500).optional(),
      notes: z.string().max(4000).optional(),
    });
    const schema = z.union([
      z.object({ urls: z.array(z.string().url()).max(2000), campaign_id: z.string().uuid().optional() }),
      z.object({ rows: z.array(rowSchema).max(2000), campaign_id: z.string().uuid().optional() }),
    ]);
    const body = schema.parse(req.body);
    const campaignId = body.campaign_id;
    if (campaignId) {
      const { data: camp } = await sb.from("campaigns").select("id").eq("id", campaignId).eq("user_id", req.userId!).maybeSingle();
      if (!camp) return reply.status(404).send({ error: "Campaña no encontrada" });
    }
    const rows =
      "urls" in body
        ? body.urls.map((profile_url) => ({ profile_url, user_id: req.userId! }))
        : body.rows.map((r) => ({ ...r, user_id: req.userId! }));
    const { data, error } = await sb.from("leads").insert(rows).select("id");
    if (error) return reply.status(400).send({ error: error.message });
    const insertedIds = (data ?? []).map((r: { id: string }) => r.id);
    if (campaignId && insertedIds.length) {
      const nextRun = new Date().toISOString();
      for (const lead_id of insertedIds) {
        const { error: enErr } = await sb.from("campaign_enrollments").insert({
          campaign_id: campaignId,
          lead_id,
          current_step_index: 0,
          next_run_at: nextRun,
          status: "paused",
          crm_status: "not_contacted",
        });
        if (enErr && !String(enErr.message).includes("duplicate")) {
          /* ignore unique violation */
        }
      }
    }
    return { inserted: insertedIds.length };
  });

  /**
   * Ejecuta Apify en este proceso (no requiere worker). La petición puede durar minutos.
   * El cliente debe usar un timeout largo (p. ej. AbortSignal.timeout 50 min).
   */
  app.post("/leads/apify-import", async (req, reply) => {
    const apifyToken = (process.env.APIFY_TOKEN ?? "").trim();
    if (!apifyToken) {
      return reply.status(400).send({ error: "Falta APIFY_TOKEN en el servidor (backend/.env)" });
    }

    const schema = z.object({
      apify_input: z.record(z.unknown()),
      apify_actor_id: z.string().optional(),
      campaign_id: z.string().uuid().optional(),
      max_wait_ms: z.number().int().min(60_000).max(6 * 60 * 60 * 1000).optional(),
      max_insert: z.number().int().min(1).max(50_000).optional(),
    });

    let body: z.infer<typeof schema>;
    try {
      body = schema.parse(req.body);
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.flatten() : String(e);
      return reply.status(400).send({ error: "Body inválido", detail: msg });
    }

    if (body.campaign_id) {
      const { data: camp } = await sb
        .from("campaigns")
        .select("id")
        .eq("id", body.campaign_id)
        .eq("user_id", req.userId!)
        .maybeSingle();
      if (!camp) return reply.status(404).send({ error: "Campaña no encontrada" });
    }

    const { DEFAULT_LEAD_ACTOR_ID } = await import("../services/apifyLeadFinder.js");
    const { executeApifyLeadImport, isApifyImportInFlightError } = await import("../services/apifyLeadImportRun.js");
    const actorRaw = String(body.apify_actor_id ?? process.env.APIFY_LEAD_ACTOR ?? DEFAULT_LEAD_ACTOR_ID).trim();
    const actorId = actorRaw.replace(/\//g, "~");

    const apifyInput = body.apify_input as Record<string, unknown>;

    const envWait = Number(process.env.APIFY_LEAD_MAX_WAIT_MS);
    const defaultWait =
      Number.isFinite(envWait) && envWait >= 60_000 ? envWait : 45 * 60 * 1000;
    const maxWaitMs = Math.min(
      Math.max(60_000, body.max_wait_ms ?? defaultWait),
      6 * 60 * 60 * 1000
    );

    const envCap = Number(process.env.APIFY_LEAD_INSERT_CAP);
    const defaultCap = Number.isFinite(envCap) && envCap >= 1 ? envCap : 2000;
    const insertCap = Math.min(50_000, Math.max(1, body.max_insert ?? defaultCap));

    try {
      const result = await executeApifyLeadImport({
        sb,
        userId: req.userId!,
        campaignId: body.campaign_id ?? null,
        apifyToken,
        actorId,
        apifyInput,
        maxWaitMs,
        insertCap,
      });
      return {
        ok: true,
        new_leads: result.newLeads,
        rows_with_linkedin: result.rowsWithLinkedIn,
        dataset_items: result.datasetSize,
        photos_resolved: result.photosResolved,
      };
    } catch (e) {
      if (isApifyImportInFlightError(e)) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.status(409).send({ error: msg });
      }
      const msg = e instanceof Error ? e.message : String(e);
      req.log.warn({ err: msg }, "apify-import failed");
      return reply.status(502).send({ error: msg });
    }
  });

  const stepTypeEnum = z.enum([
    "visit_profile",
    "connect",
    "send_message",
    "send_message_open_profile",
    "follow",
    "like_post",
    "comment_post",
    "voice_note",
    "reply_comment",
    "inmail",
  ]);

  const importJobBodySchema = z.object({
    source_type: z.enum([
      "my_list",
      "linkedin_search",
      "sales_navigator",
      "lead_finder",
      "csv",
      "linkedin_event",
      "linkedin_post",
      "linkedin_group",
    ]),
    campaign_id: z.string().uuid().optional(),
    payload: z.record(z.unknown()).default({}),
  });

  type CreateLeadImportJobOk =
    | { ok: true; job_id: string; task_id: string }
    | {
        ok: true;
        job_id: string;
        task_id: null;
        inline_apify: true;
        new_leads: number;
        rows_with_linkedin: number;
        dataset_items: number;
      };

  async function createLeadImportJob(
    userId: string,
    rawBody: unknown,
    forcedCampaignId?: string
  ): Promise<CreateLeadImportJobOk | { ok: false; status: number; error: string }> {
    const merged =
      typeof rawBody === "object" && rawBody !== null
        ? { ...(rawBody as Record<string, unknown>), ...(forcedCampaignId ? { campaign_id: forcedCampaignId } : {}) }
        : forcedCampaignId
          ? { campaign_id: forcedCampaignId }
          : rawBody;
    const body = importJobBodySchema.parse(merged);
    if (body.campaign_id) {
      const { data: camp } = await sb.from("campaigns").select("id").eq("id", body.campaign_id).eq("user_id", userId).maybeSingle();
      if (!camp) return { ok: false, status: 404, error: "Campaña no encontrada" };
    }
    const { data: job, error: jErr } = await sb
      .from("lead_import_jobs")
      .insert({
        user_id: userId,
        campaign_id: body.campaign_id ?? null,
        source_type: body.source_type,
        payload: body.payload,
        status: "pending",
      })
      .select("id")
      .single();
    if (jErr || !job) return { ok: false, status: 400, error: jErr?.message ?? "No se creó el job" };

    const isApifyLeadFinder =
      body.source_type === "lead_finder" && Boolean(process.env.APIFY_TOKEN?.trim());

    if (body.source_type === "lead_finder" && !process.env.APIFY_TOKEN?.trim()) {
      await sb
        .from("lead_import_jobs")
        .update({ status: "failed", error: "Falta APIFY_TOKEN en el servidor" })
        .eq("id", job.id);
      return {
        ok: false,
        status: 400,
        error: "Lead finder (Apify): configura APIFY_TOKEN en backend/.env. Crea un token en console.apify.com/account/integrations",
      };
    }

    /** Lead finder: ejecutar Apify en esta petición (visible en Apify Console). No usa cola ni sesión LinkedIn. */
    if (isApifyLeadFinder) {
      const apifyToken = process.env.APIFY_TOKEN!.trim();
      const jobPayload = body.payload as Record<string, unknown>;
      let apifyInput: unknown = jobPayload.apify_input;
      if (typeof apifyInput === "string") {
        try {
          apifyInput = JSON.parse(apifyInput) as Record<string, unknown>;
        } catch {
          await sb
            .from("lead_import_jobs")
            .update({ status: "failed", error: "apify_input JSON inválido", updated_at: new Date().toISOString() })
            .eq("id", job.id);
          return { ok: false, status: 400, error: "payload.apify_input no es JSON válido" };
        }
      }
      if (!apifyInput || typeof apifyInput !== "object" || Array.isArray(apifyInput)) {
        await sb
          .from("lead_import_jobs")
          .update({
            status: "failed",
            error: "Falta payload.apify_input (objeto)",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        return {
          ok: false,
          status: 400,
          error:
            "Lead finder requiere payload.apify_input (objeto). Usa la tarjeta «Apify» en Importar contactos o POST /leads/apify-import.",
        };
      }

      const { DEFAULT_LEAD_ACTOR_ID } = await import("../services/apifyLeadFinder.js");
      const { executeApifyLeadImport, isApifyImportInFlightError } = await import("../services/apifyLeadImportRun.js");
      const actorRaw = String(
        jobPayload.apify_actor_id ?? process.env.APIFY_LEAD_ACTOR ?? DEFAULT_LEAD_ACTOR_ID
      ).trim();
      const actorId = actorRaw.replace(/\//g, "~");

      const envWait = Number(process.env.APIFY_LEAD_MAX_WAIT_MS);
      const defaultWait =
        Number.isFinite(envWait) && envWait >= 60_000 ? envWait : 45 * 60 * 1000;
      const maxWaitMs = Math.min(
        Math.max(60_000, Number(jobPayload.apify_max_wait_ms) || defaultWait),
        6 * 60 * 60 * 1000
      );
      const envCap = Number(process.env.APIFY_LEAD_INSERT_CAP);
      const defaultCap = Number.isFinite(envCap) && envCap >= 1 ? envCap : 2000;
      const insertCap = Math.min(50_000, Math.max(1, Number(jobPayload.max_insert) || defaultCap));

      try {
        const result = await executeApifyLeadImport({
          sb,
          userId,
          campaignId: body.campaign_id ?? null,
          apifyToken,
          actorId,
          apifyInput: apifyInput as Record<string, unknown>,
          maxWaitMs,
          insertCap,
        });
        await sb
          .from("lead_import_jobs")
          .update({
            status: "completed",
            inserted_count: result.newLeads,
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        return {
          ok: true,
          job_id: job.id,
          task_id: null,
          inline_apify: true,
          new_leads: result.newLeads,
          rows_with_linkedin: result.rowsWithLinkedIn,
          dataset_items: result.datasetSize,
        };
      } catch (e) {
        if (isApifyImportInFlightError(e)) {
          const msg = e instanceof Error ? e.message : String(e);
          await sb
            .from("lead_import_jobs")
            .update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() })
            .eq("id", job.id);
          return { ok: false, status: 409, error: msg };
        }
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await sb
          .from("lead_import_jobs")
          .update({ status: "failed", error: msg, updated_at: new Date().toISOString() })
          .eq("id", job.id);
        return { ok: false, status: 502, error: msg };
      }
    }

    let queueAccountId: string | null = null;
    const { data: activeLi } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("connection_status", "active")
      .order("rotation_priority", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (activeLi) queueAccountId = activeLi.id as string;

    if (!queueAccountId) {
      const errMsg = "No hay cuenta LinkedIn activa para importar desde URL";
      await sb.from("lead_import_jobs").update({ status: "failed", error: errMsg }).eq("id", job.id);
      return { ok: false, status: 400, error: errMsg };
    }

    const taskId = await enqueueTask(sb, redis, {
      account_id: queueAccountId,
      action: "import_leads",
      payload: { job_id: job.id },
    });
    if (!taskId) {
      await sb.from("lead_import_jobs").update({ status: "failed", error: "No se pudo encolar tarea" }).eq("id", job.id);
      return { ok: false, status: 500, error: "Cola no disponible" };
    }
    return { ok: true, job_id: job.id, task_id: taskId };
  }

  app.post("/leads/import-job", async (req, reply) => {
    const r = await createLeadImportJob(req.userId!, req.body);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    if ("inline_apify" in r && r.inline_apify) {
      return {
        job_id: r.job_id,
        task_id: null,
        inline_apify: true,
        new_leads: r.new_leads,
        rows_with_linkedin: r.rows_with_linkedin,
        dataset_items: r.dataset_items,
      };
    }
    return { job_id: r.job_id, task_id: r.task_id };
  });

  app.get("/campaigns", async (req) => {
    const { data, error } = await sb.from("campaigns").select("*").eq("user_id", req.userId!);
    if (error) throw error;
    return { campaigns: data ?? [] };
  });

  app.post("/campaigns", async (req, reply) => {
    const schema = z.object({ name: z.string().min(1) });
    const body = schema.parse(req.body);
    const { data, error } = await sb.from("campaigns").insert({ name: body.name, user_id: req.userId! }).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { campaign: data };
  });

  app.get("/campaigns/:id/enrollments", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: c } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!c) return reply.status(404).send({ error: "Not found" });
    const { data, error } = await sb
      .from("campaign_enrollments")
      .select("*, leads (*)")
      .eq("campaign_id", id);
    if (error) throw error;
    return { enrollments: data ?? [] };
  });

  app.patch("/campaigns/:id/enrollments/:enrollmentId", async (req, reply) => {
    const { id, enrollmentId } = req.params as { id: string; enrollmentId: string };
    const schema = z.object({ crm_status: z.enum([
      "not_contacted", "in_campaign", "contacted", "replied", "not_accepted", "blacklist", "duplicate", "failed",
    ]) });
    const body = schema.parse(req.body);
    const { data: en } = await sb
      .from("campaign_enrollments")
      .select("id, campaign_id")
      .eq("id", enrollmentId)
      .eq("campaign_id", id)
      .maybeSingle();
    if (!en) return reply.status(404).send({ error: "Not found" });
    const { data: camp } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!camp) return reply.status(404).send({ error: "Not found" });
    const { data, error } = await sb
      .from("campaign_enrollments")
      .update({ crm_status: body.crm_status })
      .eq("id", enrollmentId)
      .select("*, leads (*)")
      .single();
    if (error) return reply.status(400).send({ error: error.message });
    return { enrollment: data };
  });

  app.post("/campaigns/:id/enrollments", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({ lead_ids: z.array(z.string().uuid()).min(1).max(2000) });
    const body = schema.parse(req.body);
    const { data: camp } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!camp) return reply.status(404).send({ error: "Not found" });
    const nextRun = new Date().toISOString();
    let added = 0;
    for (const lead_id of body.lead_ids) {
      const { data: lead } = await sb.from("leads").select("id").eq("id", lead_id).eq("user_id", req.userId!).maybeSingle();
      if (!lead) continue;
      const { error: insErr } = await sb.from("campaign_enrollments").insert({
        campaign_id: id,
        lead_id,
        current_step_index: 0,
        next_run_at: nextRun,
        status: "paused",
        crm_status: "not_contacted",
      });
      if (!insErr) added++;
    }
    return { added };
  });

  app.get("/campaigns/:id/analytics", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: c } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!c) return reply.status(404).send({ error: "Not found" });
    const { data: ens } = await sb.from("campaign_enrollments").select("id").eq("campaign_id", id);
    const eids = (ens ?? []).map((e: { id: string }) => e.id);
    if (!eids.length) {
      return {
        summary: {
          tasks_by_action: {},
          invites_sent: 0,
          messages_sent: 0,
          inmails_sent: 0,
          likes: 0,
          comments: 0,
          profile_visits: 0,
          accepts_pct: null,
          replies_pct: null,
          open_messages_est: 0,
        },
        series: [],
      };
    }
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: tasks } = await sb
      .from("tasks")
      .select("id, action, status, created_at, enrollment_id")
      .in("enrollment_id", eids)
      .gte("created_at", since);
    const byAction: Record<string, number> = {};
    for (const t of tasks ?? []) {
      const a = (t as { action: string }).action;
      byAction[a] = (byAction[a] ?? 0) + 1;
    }
    const completed = (tasks ?? []).filter((t: { status: string }) => t.status === "completed");
    const invites = completed.filter((t: { action: string }) => t.action === "connect").length;
    const msgs = completed.filter((t: { action: string }) =>
      ["send_message", "send_message_open_profile"].includes(t.action)
    ).length;
    const inmails = completed.filter((t: { action: string }) => t.action === "inmail").length;
    const likes = completed.filter((t: { action: string }) => t.action === "like_post").length;
    const comments = completed.filter((t: { action: string }) => t.action === "comment_post").length;
    const visits = completed.filter((t: { action: string }) => t.action === "visit_profile").length;
    const enrollTotal = eids.length;
    const { count: repliedCount } = await sb
      .from("campaign_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id)
      .eq("crm_status", "replied");
    const acceptsPct = enrollTotal ? Math.round(((repliedCount ?? 0) / enrollTotal) * 1000) / 10 : null;
    const repliesPct = msgs ? Math.round(((repliedCount ?? 0) / msgs) * 1000) / 10 : null;
    return {
      summary: {
        tasks_by_action: byAction,
        linkedin_requests: invites,
        linkedin_conversations: msgs,
        linkedin_open_messages_est: msgs,
        linkedin_likes: likes,
        linkedin_comments: comments,
        linkedin_inmails_sent: inmails,
        profile_visits: visits,
        accepted_invite_pct: acceptsPct,
        linkedin_replies_pct: repliesPct,
      },
      note: "Porcentajes aproximados según crm_status=replied y tareas completadas; afinar con eventos dedicados.",
    };
  });

  app.post("/campaigns/:id/import-job", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: camp } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!camp) return reply.status(404).send({ error: "Not found" });
    const r = await createLeadImportJob(req.userId!, req.body, id);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    if ("inline_apify" in r && r.inline_apify) {
      return {
        job_id: r.job_id,
        task_id: null,
        inline_apify: true,
        new_leads: r.new_leads,
        rows_with_linkedin: r.rows_with_linkedin,
        dataset_items: r.dataset_items,
      };
    }
    return { job_id: r.job_id, task_id: r.task_id };
  });

  app.get("/campaigns/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data, error } = await sb.from("campaigns").select("*").eq("id", id).eq("user_id", req.userId!).single();
    if (error || !data) return reply.status(404).send({ error: "Not found" });
    return { campaign: data };
  });

  app.patch("/campaigns/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      name: z.string().min(1).optional(),
      skip_contacted_other_campaigns: z.boolean().optional(),
      schedule_json: z.array(z.object({
        day: z.number().int().min(0).max(6),
        enabled: z.boolean(),
        start: z.string(),
        end: z.string(),
      })).optional(),
      frequency_limits: z.record(z.number()).optional(),
      workflow_edges: z.array(z.record(z.unknown())).optional(),
    });
    const body = schema.parse(req.body ?? {});
    const { data: c } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).maybeSingle();
    if (!c) return reply.status(404).send({ error: "Not found" });
    const patch: Record<string, unknown> = { ...body };
    if (!Object.keys(patch).length) return reply.status(400).send({ error: "Nada que actualizar" });
    const { data, error } = await sb.from("campaigns").update(patch).eq("id", id).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { campaign: data };
  });

  app.delete("/campaigns/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { error } = await sb.from("campaigns").delete().eq("id", id).eq("user_id", req.userId!);
    if (error) return reply.status(400).send({ error: error.message });
    return { ok: true };
  });

  app.get("/campaigns/:id/steps", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: c } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!c) return reply.status(404).send({ error: "Not found" });
    const { data, error } = await sb.from("campaign_steps").select("*").eq("campaign_id", id).order("step_order", { ascending: true });
    if (error) throw error;
    return { steps: data ?? [] };
  });

  app.put("/campaigns/:id/steps", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: c } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!c) return reply.status(404).send({ error: "Not found" });

    const schema = z.object({
      workflow_edges: z.array(z.record(z.unknown())).optional(),
      steps: z.array(
        z.object({
          step_type: stepTypeEnum,
          delay_hours: z.number().int().min(0),
          message_template: z.string().optional(),
          position_x: z.number().nullable().optional(),
          position_y: z.number().nullable().optional(),
        })
      ),
    });
    const body = schema.parse(req.body);
    if (body.workflow_edges !== undefined) {
      const { error: e2 } = await sb.from("campaigns").update({ workflow_edges: body.workflow_edges }).eq("id", id);
      if (e2) return reply.status(400).send({ error: e2.message });
    }
    await sb.from("campaign_steps").delete().eq("campaign_id", id);
    const rows = body.steps.map((s, i) => ({
      campaign_id: id,
      step_order: i,
      step_type: s.step_type,
      delay_hours: s.delay_hours,
      message_template: s.message_template ?? null,
      position_x: s.position_x ?? null,
      position_y: s.position_y ?? null,
    }));
    const { error } = await sb.from("campaign_steps").insert(rows);
    if (error) return reply.status(400).send({ error: error.message });
    const { data: steps } = await sb.from("campaign_steps").select("*").eq("campaign_id", id).order("step_order", { ascending: true });
    return { ok: true, steps: steps ?? [] };
  });

  app.post("/campaigns/:id/start", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({ lead_ids: z.array(z.string().uuid()).optional() });
    const body = schema.parse(req.body ?? {});

    const { data: camp } = await sb
      .from("campaigns")
      .select("id, skip_contacted_other_campaigns")
      .eq("id", id)
      .eq("user_id", req.userId!)
      .single();
    if (!camp) return reply.status(404).send({ error: "Not found" });

    const { data: activeLi } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", req.userId!)
      .eq("connection_status", "active")
      .order("rotation_priority", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!activeLi) {
      return reply
        .status(400)
        .send({ error: "No hay cuenta LinkedIn en estado «active». Conéctala en Cuentas y espera la verificación." });
    }

    let leadIds = body.lead_ids;
    if (!leadIds?.length) {
      const { data: leads } = await sb.from("leads").select("id").eq("user_id", req.userId!);
      leadIds = leads?.map((l) => l.id) ?? [];
    }
    if (camp.skip_contacted_other_campaigns) {
      leadIds = await filterLeadIdsSkipContactedOtherCampaigns(sb, id, leadIds);
    }
    if (!leadIds.length) return reply.status(400).send({ error: "No leads" });

    const { data: anyStep } = await sb
      .from("campaign_steps")
      .select("id")
      .eq("campaign_id", id)
      .limit(1)
      .maybeSingle();
    if (!anyStep) {
      return reply.status(400).send({
        error:
          "No hay pasos guardados para esta campaña. Pulsa «Guardar pasos» (o usa Iniciar tras guardar) y vuelve a intentarlo.",
      });
    }

    await sb.from("campaigns").update({ status: "active" }).eq("id", id);
    const sched = await createEnrollmentsAndSchedule(sb, redis, id, leadIds);
    return {
      ok: true,
      leads: leadIds.length,
      tasks_scheduled: sched.tasks_scheduled,
      enrollments_new: sched.enrollments_new,
      enrollments_existing: sched.enrollments_existing,
    };
  });

  app.post("/campaigns/:id/pause", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { error } = await sb.from("campaigns").update({ status: "paused" }).eq("id", id).eq("user_id", req.userId!);
    if (error) return reply.status(400).send({ error: error.message });
    await sb.from("campaign_enrollments").update({ status: "paused" }).eq("campaign_id", id);
    return { ok: true };
  });

  app.get("/posts", async (req) => {
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { posts: [] };
    const { data, error } = await sb
      .from("posts")
      .select("*")
      .in("account_id", ids)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) throw error;
    return { posts: data ?? [] };
  });

  app.post("/posts", async (req, reply) => {
    const schema = z.object({
      account_id: z.string().uuid(),
      content: z.string().min(1),
      image_url: z.string().nullable().optional(),
    });
    const body = schema.parse(req.body);
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", body.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const { data: post, error } = await sb
      .from("posts")
      .insert({
        account_id: body.account_id,
        content: body.content,
        image_url: body.image_url ?? null,
        status: "draft",
      })
      .select("*")
      .single();
    if (error) return reply.status(400).send({ error: error.message });
    return { post };
  });

  app.patch("/posts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      content: z.string().min(1).optional(),
      image_url: z.string().nullable().optional(),
    });
    const body = schema.parse(req.body ?? {});
    const { data: post } = await sb.from("posts").select("id, account_id, status").eq("id", id).maybeSingle();
    if (!post) return reply.status(404).send({ error: "Not found" });
    const { data: acc } = await sb.from("linkedin_accounts").select("user_id").eq("id", post.account_id).single();
    if (!acc || acc.user_id !== req.userId) return reply.status(404).send({ error: "Not found" });
    if (post.status !== "draft") return reply.status(400).send({ error: "Solo se editan borradores" });
    const { data, error } = await sb.from("posts").update(body).eq("id", id).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { post: data };
  });

  app.post("/posts/generate", async (req, reply) => {
    const schema = z.object({ topic: z.string().min(1), with_image: z.boolean().optional() });
    const body = schema.parse(req.body);
    if (!process.env.GEMINI_API_KEY) return reply.status(503).send({ error: "GEMINI_API_KEY not configured" });

    const { text, imageDescription } = await generatePost(body.topic);
    let image_url: string | null = null;
    if (body.with_image && imageDescription) {
      const bytes = await generateImageBytes(imageDescription);
      if (bytes) {
        image_url = `data:image/png;base64,${bytes.toString("base64")}`;
      }
    }

    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!).limit(1).maybeSingle();
    if (!accounts) return reply.status(400).send({ error: "Add a LinkedIn account first" });

    const { data: post, error } = await sb
      .from("posts")
      .insert({
        account_id: accounts.id,
        content: text,
        image_url,
        status: "draft",
      })
      .select("*")
      .single();
    if (error) return reply.status(400).send({ error: error.message });
    return { post };
  });

  app.post("/posts/:id/schedule", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      scheduled_time: z.string().datetime(),
      content: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const { data: post } = await sb.from("posts").select("id, account_id").eq("id", id).single();
    if (!post) return reply.status(404).send({ error: "Not found" });
    const { data: acc } = await sb.from("linkedin_accounts").select("user_id").eq("id", post.account_id).single();
    if (!acc || acc.user_id !== req.userId) return reply.status(404).send({ error: "Not found" });

    const { error } = await sb
      .from("posts")
      .update({
        scheduled_time: body.scheduled_time,
        status: "scheduled",
        ...(body.content ? { content: body.content } : {}),
      })
      .eq("id", id);
    if (error) return reply.status(400).send({ error: error.message });

    const taskId = await enqueueTask(sb, redis, {
      account_id: post.account_id,
      action: "publish_post",
      scheduled_at: body.scheduled_time,
      payload: { post_id: id },
    });
    return { ok: true, task_id: taskId };
  });

  app.get("/keyword-rules", async (req) => {
    const { data, error } = await sb.from("keyword_rules").select("*").eq("user_id", req.userId!);
    if (error) throw error;
    return { rules: data ?? [] };
  });

  app.post("/keyword-rules", async (req, reply) => {
    const schema = z.object({
      keyword: z.string().min(1),
      reply_template: z.string().min(1),
      rule_type: z.enum(["dm", "comment"]).default("dm"),
      use_ai: z.boolean().optional(),
      is_active: z.boolean().optional(),
      account_id: z.string().uuid().nullable().optional(),
      post_id: z.string().uuid().nullable().optional(),
      dm_followup_template: z.string().nullable().optional(),
      dm_followup_use_ai: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    if (body.account_id) {
      const { data: a } = await sb
        .from("linkedin_accounts")
        .select("id")
        .eq("id", body.account_id)
        .eq("user_id", req.userId!)
        .maybeSingle();
      if (!a) return reply.status(400).send({ error: "account_id no válido" });
    }
    if (body.post_id) {
      const { data: p } = await sb.from("posts").select("account_id").eq("id", body.post_id).maybeSingle();
      if (!p) return reply.status(400).send({ error: "post_id no válido" });
      const { data: a } = await sb
        .from("linkedin_accounts")
        .select("id")
        .eq("id", p.account_id)
        .eq("user_id", req.userId!)
        .maybeSingle();
      if (!a) return reply.status(400).send({ error: "post_id no válido" });
    }
    const { data, error } = await sb
      .from("keyword_rules")
      .insert({
        ...body,
        user_id: req.userId!,
        dm_followup_use_ai: body.dm_followup_use_ai ?? false,
        is_active: body.is_active ?? true,
      })
      .select("*")
      .single();
    if (error) return reply.status(400).send({ error: error.message });
    return { rule: data };
  });

  app.patch("/keyword-rules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({
      keyword: z.string().min(1).optional(),
      reply_template: z.string().min(1).optional(),
      rule_type: z.enum(["dm", "comment"]).optional(),
      use_ai: z.boolean().optional(),
      is_active: z.boolean().optional(),
      account_id: z.string().uuid().nullable().optional(),
      post_id: z.string().uuid().nullable().optional(),
      dm_followup_template: z.string().nullable().optional(),
      dm_followup_use_ai: z.boolean().optional(),
    });
    const body = schema.parse(req.body ?? {});
    if (!Object.keys(body).length) return reply.status(400).send({ error: "Nada que actualizar" });
    const { data: existing } = await sb.from("keyword_rules").select("id").eq("id", id).eq("user_id", req.userId!).maybeSingle();
    if (!existing) return reply.status(404).send({ error: "Not found" });
    if (body.account_id) {
      const { data: a } = await sb
        .from("linkedin_accounts")
        .select("id")
        .eq("id", body.account_id)
        .eq("user_id", req.userId!)
        .maybeSingle();
      if (!a) return reply.status(400).send({ error: "account_id no válido" });
    }
    if (body.post_id) {
      const { data: p } = await sb.from("posts").select("account_id").eq("id", body.post_id).maybeSingle();
      if (!p) return reply.status(400).send({ error: "post_id no válido" });
      const { data: a } = await sb
        .from("linkedin_accounts")
        .select("id")
        .eq("id", p.account_id)
        .eq("user_id", req.userId!)
        .maybeSingle();
      if (!a) return reply.status(400).send({ error: "post_id no válido" });
    }
    const { data, error } = await sb.from("keyword_rules").update(body).eq("id", id).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { rule: data };
  });

  app.delete("/keyword-rules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await sb.from("keyword_rules").delete().eq("id", id).eq("user_id", req.userId!);
    return { ok: true };
  });

  app.get("/crm-summary", async (req) => {
    const userId = req.userId!;

    // Cuentas del usuario
    const { data: accounts } = await sb.from("linkedin_accounts").select("id,connection_status,li_display_name").eq("user_id", userId);
    const accountIds = (accounts ?? []).map((a) => a.id);

    // Pipeline: enrollments agrupados por crm_status
    const { data: enrollments } = await sb
      .from("campaign_enrollments")
      .select("crm_status, status, campaign_id, lead_id, leads(id, name, photo_url, title, company)")
      .in("campaign_id", (await sb.from("campaigns").select("id").eq("user_id", userId)).data?.map((c) => c.id) ?? []);

    const pipeline: Record<string, number> = {
      not_contacted: 0, in_campaign: 0, contacted: 0, replied: 0, not_accepted: 0, blacklist: 0,
    };
    for (const e of enrollments ?? []) {
      const k = e.crm_status as string;
      if (k in pipeline) pipeline[k]++;
    }

    // Últimos 8 leads que respondieron (replied)
    const recentReplied = (enrollments ?? [])
      .filter((e) => e.crm_status === "replied")
      .slice(0, 8)
      .map((e) => {
        const l = (e.leads as unknown) as { id: string; name: string | null; photo_url: string | null; title: string | null; company: string | null } | null;
        return { lead_id: e.lead_id, name: l?.name ?? null, photo_url: l?.photo_url ?? null, title: l?.title ?? null, company: l?.company ?? null };
      });

    // Campañas activas
    const { data: campaigns } = await sb.from("campaigns").select("id,name,status").eq("user_id", userId).eq("status", "active");

    // Tareas: conteo por estado
    const taskCountsRaw = await Promise.all(
      (["pending", "running", "completed", "dead"] as const).map(async (s) => {
        const { count } = await sb.from("tasks").select("id", { count: "exact", head: true }).in("account_id", accountIds).eq("status", s);
        return [s, count ?? 0] as const;
      })
    );
    const taskCounts = Object.fromEntries(taskCountsRaw);

    // Últimos 6 mensajes enviados
    const { data: recentMessages } = await sb
      .from("messages")
      .select("id, body, created_at, direction, account_id, peer_name, peer_photo_url")
      .in("account_id", accountIds)
      .order("created_at", { ascending: false })
      .limit(6);

    // Total leads
    const { count: totalLeads } = await sb.from("leads").select("id", { count: "exact", head: true }).eq("user_id", userId);

    return {
      pipeline,
      recent_replied: recentReplied,
      campaigns_active: campaigns ?? [],
      task_counts: taskCounts,
      recent_messages: recentMessages ?? [],
      total_leads: totalLeads ?? 0,
      accounts_active: (accounts ?? []).filter((a) => a.connection_status === "active").length,
    };
  });

  app.get("/tasks", async (req) => {
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { tasks: [] };
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 200)));
    let qb = sb.from("tasks").select("*").in("account_id", ids).order("created_at", { ascending: false }).limit(limit);
    if (q.status && q.status !== "all") qb = qb.eq("status", q.status);
    const { data, error } = await qb;
    if (error) throw error;
    return { tasks: data ?? [] };
  });

  app.delete("/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { ok: false };
    const { data: task } = await sb.from("tasks").select("id, account_id, status").eq("id", id).maybeSingle();
    if (!task || !ids.includes(task.account_id as string)) return { ok: false, error: "not_found" };
    await sb.from("tasks").delete().eq("id", id);
    return { ok: true };
  });

  app.delete("/tasks", async (req) => {
    const schema = z.object({ status: z.enum(["pending", "running", "failed", "completed", "dead", "all"]) });
    const body = schema.parse(req.body ?? {});
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { deleted: 0 };
    const q = sb.from("tasks").delete({ count: "exact" }).in("account_id", ids);
    const { count } = body.status === "all" ? await q : await q.eq("status", body.status);
    return { deleted: count ?? 0 };
  });

  app.get("/messages", async (req) => {
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { messages: [] };
    const { data, error } = await sb
      .from("messages")
      .select("*")
      .in("account_id", ids)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { messages: data ?? [] };
  });

  app.get("/inbound-comment-events", async (req) => {
    const { data, error } = await sb
      .from("inbound_comment_events")
      .select("*")
      .eq("user_id", req.userId!)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { events: data ?? [] };
  });

  app.get("/inbox", async (req) => {
    const { data: accounts } = await sb
      .from("linkedin_accounts")
      .select("id, li_display_name")
      .eq("user_id", req.userId!);
    const ids = (accounts ?? []).map((a) => a.id);
    if (!ids.length) return { threads: [] };
    const q = req.query as { account_id?: string };
    const filterIds = q.account_id && ids.includes(q.account_id) ? [q.account_id] : ids;
    const { data: convRows, error: convErr } = await sb
      .from("inbox_conversations")
      .select(
        "account_id, conversation_id, peer_name, peer_photo_url, list_preview, updated_at, list_rank, list_last_activity_at"
      )
      .in("account_id", filterIds)
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (convErr) throw convErr;
    const conversations = convRows ?? [];
    const accName = new Map((accounts ?? []).map((a) => [a.id, a.li_display_name ?? "Cuenta LinkedIn"]));

    const convKeys = conversations.map((c) => c.conversation_id);
    const lastByConv = new Map<string, { direction: string; created_at: string }>();
    if (convKeys.length > 0) {
      const { data: msgRows, error: msgErr } = await sb
        .from("messages")
        .select("conversation_id, direction, created_at")
        .in("account_id", filterIds)
        .in("conversation_id", convKeys)
        .order("created_at", { ascending: false })
        .limit(8000);
      if (msgErr) throw msgErr;
      for (const m of msgRows ?? []) {
        if (!lastByConv.has(m.conversation_id)) {
          lastByConv.set(m.conversation_id, { direction: m.direction, created_at: m.created_at });
        }
      }
    }

    const threads = conversations
      .map((c) => {
        const last = lastByConv.get(c.conversation_id);
        const lrRaw = (c as { list_rank?: number | string | null }).list_rank;
        const lr =
          lrRaw != null && lrRaw !== "" && Number.isFinite(Number(lrRaw)) ? Number(lrRaw) : null;
        const listAct = (c as { list_last_activity_at?: string | null }).list_last_activity_at;
        const cand = [last?.created_at, listAct, c.updated_at].filter(Boolean) as string[];
        let last_at = (last?.created_at ?? listAct ?? c.updated_at) as string;
        let maxMs = 0;
        for (const s of cand) {
          const ms = new Date(s).getTime();
          if (!Number.isNaN(ms) && ms >= maxMs) {
            maxMs = ms;
            last_at = s;
          }
        }
        return {
          account_id: c.account_id,
          conversation_id: c.conversation_id,
          peer_name: c.peer_name ?? null,
          peer_photo_url: c.peer_photo_url ?? null,
          preview: (c.list_preview ?? "—").slice(0, 220),
          last_direction: last?.direction ?? "in",
          last_at,
          list_rank: lr,
          account_label: accName.get(c.account_id) ?? c.account_id.slice(0, 8),
        };
      })
      .sort((a, b) => {
        const ta = new Date(a.last_at).getTime();
        const tb = new Date(b.last_at).getTime();
        if (tb !== ta) return tb - ta;
        const ar = a.list_rank;
        const br = b.list_rank;
        if (ar != null && br != null && ar !== br) return ar - br;
        if (ar != null && br == null) return -1;
        if (ar == null && br != null) return 1;
        return a.conversation_id.localeCompare(b.conversation_id);
      });
    const last_message_at = threads.length > 0 ? threads[0].last_at : null;
    return { threads, last_message_at };
  });

  app.get("/inbox/thread", async (req, reply) => {
    const q = req.query as { account_id?: string; conversation_id?: string };
    if (!q.account_id || !q.conversation_id) {
      return reply.status(400).send({ error: "account_id y conversation_id son obligatorios" });
    }
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", q.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const { data, error } = await sb
      .from("messages")
      .select("*")
      .eq("account_id", q.account_id)
      .eq("conversation_id", q.conversation_id)
      .order("created_at", { ascending: true })
      .limit(250);
    if (error) throw error;
    return { messages: data ?? [] };
  });

  function isAllowedAttachmentProxyUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      const h = u.hostname.toLowerCase();
      return (
        h === "linkedin.com" ||
        h.endsWith(".linkedin.com") ||
        h === "licdn.com" ||
        h.endsWith(".licdn.com")
      );
    } catch {
      return false;
    }
  }

  app.get("/inbox/attachment/proxy", async (req, reply) => {
    const q = req.query as { account_id?: string; url?: string; filename?: string };
    if (!q.account_id || !q.url?.trim()) {
      return reply.status(400).send({ error: "account_id y url son obligatorios" });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(q.url.trim());
    } catch {
      return reply.status(400).send({ error: "url inválida" });
    }
    if (!decoded.startsWith("https://") || !isAllowedAttachmentProxyUrl(decoded)) {
      return reply.status(400).send({ error: "URL no permitida (solo dominios LinkedIn / licdn)" });
    }
    const { data: acc, error: accErr } = await sb
      .from("linkedin_accounts")
      .select("li_at_cookie")
      .eq("id", q.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (accErr || !acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
    let liAt: string;
    try {
      liAt = decryptSecret((acc as { li_at_cookie: string }).li_at_cookie);
    } catch {
      return reply.status(500).send({ error: "No se pudo leer la sesión de la cuenta" });
    }
    const upstream = await fetch(decoded, {
      redirect: "follow",
      headers: {
        Cookie: `li_at=${liAt}`,
        Referer: "https://www.linkedin.com/messaging/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });
    if (!upstream.ok) {
      return reply.status(502).send({ error: `LinkedIn respondió ${upstream.status}` });
    }
    const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
    reply.header("Content-Type", ct);
    const cd = upstream.headers.get("content-disposition");
    if (cd) reply.header("Content-Disposition", cd);
    else if (q.filename?.trim()) {
      const safe = q.filename.trim().replace(/["\r\n]/g, "_").slice(0, 180);
      reply.header("Content-Disposition", `attachment; filename="${safe}"`);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return reply.send(buf);
  });

  app.post("/inbox/send", async (req, reply) => {
    const schema = z
      .object({
        account_id: z.string().uuid(),
        conversation_id: z.string().min(1).optional(),
        thread_url: z.string().min(1).optional(),
        text: z.string().min(1).max(8000),
      })
      .refine((b) => Boolean((b.conversation_id && b.conversation_id.trim()) || (b.thread_url && b.thread_url.trim())), {
        message: "conversation_id o thread_url requerido",
      });
    const body = schema.parse(req.body);
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", body.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const taskId = await enqueueTask(sb, redis, {
      account_id: body.account_id,
      action: "reply_dm",
      payload: {
        conversation_id: body.conversation_id?.trim(),
        thread_url: body.thread_url?.trim(),
        text: body.text.trim(),
      },
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar el envío" });
    return { ok: true, task_id: taskId };
  });

  app.post("/inbox/sync", async (req, reply) => {
    const body = z
      .object({
        account_id: z.string().uuid(),
        background: z.boolean().optional(),
        /** Cancela sync_inbox pendientes/en curso de esta cuenta y encola una nueva. */
        force: z.boolean().optional(),
      })
      .parse(req.body);
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", body.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });

    const failStale = {
      status: "failed" as const,
      error_message: "stale_sync_inbox_abandoned",
      locked_at: null as null,
    };

    if (body.force) {
      await sb
        .from("tasks")
        .update({ status: "failed", error_message: "force_resync_inbox", locked_at: null })
        .eq("account_id", body.account_id)
        .eq("action", "sync_inbox")
        .in("status", ["pending", "running"]);
    } else {
      const staleSec = Number(process.env.INBOX_SYNC_STALE_RUNNING_SEC ?? 20 * 60);
      if (Number.isFinite(staleSec) && staleSec >= 120) {
        const staleIso = new Date(Date.now() - staleSec * 1000).toISOString();
        await sb
          .from("tasks")
          .update(failStale)
          .eq("account_id", body.account_id)
          .eq("action", "sync_inbox")
          .eq("status", "running")
          .not("locked_at", "is", null)
          .lt("locked_at", staleIso);
        await sb
          .from("tasks")
          .update(failStale)
          .eq("account_id", body.account_id)
          .eq("action", "sync_inbox")
          .eq("status", "running")
          .is("locked_at", null)
          .lt("created_at", staleIso);
      }
    }

    const { data: dupRows } = await sb
      .from("tasks")
      .select("id")
      .eq("account_id", body.account_id)
      .eq("action", "sync_inbox")
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: false })
      .limit(1);
    const dup = dupRows?.[0];
    if (dup?.id) {
      return { ok: true, task_id: dup.id, deduped: true };
    }
    const taskId = await enqueueTask(sb, redis, {
      account_id: body.account_id,
      action: "sync_inbox",
      payload: {},
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar la sincronización" });
    return { ok: true, task_id: taskId, deduped: false };
  });

  app.post("/inbox/thread/sync", async (req, reply) => {
    const body = z
      .object({
        account_id: z.string().uuid(),
        conversation_id: z.string().min(1),
        keywords_auto_reply: z.boolean().optional(),
      })
      .parse(req.body);
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", body.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
    const convId = body.conversation_id.trim();
    const { data: dupCandidates } = await sb
      .from("tasks")
      .select("id, payload")
      .eq("account_id", body.account_id)
      .eq("action", "sync_inbox_thread")
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: false })
      .limit(25);
    const dup = (dupCandidates ?? []).find(
      (t) => String((t.payload as { conversation_id?: string } | null)?.conversation_id ?? "").trim() === convId
    );
    if (dup?.id) {
      return { ok: true, task_id: dup.id, deduped: true };
    }
    const taskId = await enqueueTask(sb, redis, {
      account_id: body.account_id,
      action: "sync_inbox_thread",
      payload: {
        conversation_id: convId,
        keywords_auto_reply: body.keywords_auto_reply ?? false,
      },
    });
    if (!taskId) return reply.status(500).send({ error: "No se pudo encolar la sincronización del hilo" });
    return { ok: true, task_id: taskId, deduped: false };
  });

  app.post("/enrollments/:id/reschedule", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { data: en } = await sb.from("campaign_enrollments").select("campaign_id").eq("id", id).single();
    if (!en) return reply.status(404).send({ error: "Not found" });
    const { data: camp } = await sb.from("campaigns").select("user_id").eq("id", en.campaign_id).single();
    if (!camp || camp.user_id !== req.userId) return reply.status(404).send({ error: "Not found" });
    await scheduleEnrollmentStep(sb, redis, id);
    return { ok: true };
  });
}
