import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getQueueMode } from "../queues/redisClient.js";
import { encryptSecret, maskSecret } from "../lib/crypto.js";
import { createEnrollmentsAndSchedule, scheduleEnrollmentStep } from "../services/campaignEngine.js";
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
        "id,proxy_id,warmup_state,softban_status,paused_until,connection_status,last_warmup_at,created_at,li_display_name,li_headline,li_photo_url,session_verified_at"
      )
      .eq("user_id", req.userId!);
    if (error) throw error;
    return { accounts: data ?? [] };
  });

  app.post("/linkedin-accounts", async (req, reply) => {
    const body = liAccountBody.parse(req.body);
    const proxyId = body.proxy_id ?? (await pickProxyForAccount(sb));
    const enc = encryptSecret(body.li_at.trim());
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

  app.get("/leads", async (req) => {
    const { data, error } = await sb.from("leads").select("*").eq("user_id", req.userId!).order("created_at", { ascending: false });
    if (error) throw error;
    return { leads: data ?? [] };
  });

  app.post("/leads", async (req, reply) => {
    const schema = z.object({
      profile_url: z.string().url(),
      name: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
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

  app.post("/leads/import", async (req, reply) => {
    const schema = z.object({
      urls: z.array(z.string().url()).max(500),
    });
    const body = schema.parse(req.body);
    const rows = body.urls.map((profile_url) => ({ profile_url, user_id: req.userId! }));
    const { data, error } = await sb.from("leads").insert(rows).select("id");
    if (error) return reply.status(400).send({ error: error.message });
    return { inserted: data?.length ?? 0 };
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
      steps: z.array(
        z.object({
          step_type: z.enum([
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
          ]),
          delay_hours: z.number().int().min(0),
          message_template: z.string().optional(),
        })
      ),
    });
    const body = schema.parse(req.body);
    await sb.from("campaign_steps").delete().eq("campaign_id", id);
    const rows = body.steps.map((s, i) => ({
      campaign_id: id,
      step_order: i,
      step_type: s.step_type,
      delay_hours: s.delay_hours,
      message_template: s.message_template ?? null,
    }));
    const { error } = await sb.from("campaign_steps").insert(rows);
    if (error) return reply.status(400).send({ error: error.message });
    return { ok: true };
  });

  app.post("/campaigns/:id/start", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const schema = z.object({ lead_ids: z.array(z.string().uuid()).optional() });
    const body = schema.parse(req.body ?? {});

    const { data: camp } = await sb.from("campaigns").select("id").eq("id", id).eq("user_id", req.userId!).single();
    if (!camp) return reply.status(404).send({ error: "Not found" });

    const { data: activeLi } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("user_id", req.userId!)
      .eq("connection_status", "active")
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
    const { data, error } = await sb.from("posts").select("*").in("account_id", ids).order("created_at", { ascending: false });
    if (error) throw error;
    return { posts: data ?? [] };
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
    });
    const body = schema.parse(req.body);
    const { data, error } = await sb.from("keyword_rules").insert({ ...body, user_id: req.userId! }).select("*").single();
    if (error) return reply.status(400).send({ error: error.message });
    return { rule: data };
  });

  app.delete("/keyword-rules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await sb.from("keyword_rules").delete().eq("id", id).eq("user_id", req.userId!);
    return { ok: true };
  });

  app.get("/tasks", async (req) => {
    const { data: accounts } = await sb.from("linkedin_accounts").select("id").eq("user_id", req.userId!);
    const ids = accounts?.map((a) => a.id) ?? [];
    if (!ids.length) return { tasks: [] };
    const { data, error } = await sb
      .from("tasks")
      .select("*")
      .in("account_id", ids)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { tasks: data ?? [] };
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

  app.get("/inbox", async (req) => {
    const { data: accounts } = await sb
      .from("linkedin_accounts")
      .select("id, li_display_name")
      .eq("user_id", req.userId!);
    const ids = (accounts ?? []).map((a) => a.id);
    if (!ids.length) return { threads: [] };
    const q = req.query as { account_id?: string };
    const filterIds = q.account_id && ids.includes(q.account_id) ? [q.account_id] : ids;
    const { data: rows, error } = await sb
      .from("messages")
      .select("id, account_id, conversation_id, message_text, direction, created_at, peer_name")
      .in("account_id", filterIds)
      .order("created_at", { ascending: false })
      .limit(800);
    if (error) throw error;
    const list = rows ?? [];
    const accName = new Map((accounts ?? []).map((a) => [a.id, a.li_display_name ?? "Cuenta LinkedIn"]));
    const threadMap = new Map<
      string,
      {
        account_id: string;
        conversation_id: string;
        peer_name: string | null;
        preview: string;
        last_direction: string;
        last_at: string;
        account_label: string;
      }
    >();
    for (const m of list) {
      const k = `${m.account_id}::${m.conversation_id}`;
      if (!threadMap.has(k)) {
        threadMap.set(k, {
          account_id: m.account_id,
          conversation_id: m.conversation_id,
          peer_name: m.peer_name ?? null,
          preview: (m.message_text ?? "").slice(0, 220),
          last_direction: m.direction,
          last_at: m.created_at,
          account_label: accName.get(m.account_id) ?? m.account_id.slice(0, 8),
        });
      }
    }
    const threads = [...threadMap.values()].sort(
      (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
    );
    const last_message_at = list.length > 0 ? list[0].created_at : null;
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
      .object({ account_id: z.string().uuid(), background: z.boolean().optional() })
      .parse(req.body);
    const { data: acc } = await sb
      .from("linkedin_accounts")
      .select("id")
      .eq("id", body.account_id)
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!acc) return reply.status(404).send({ error: "Cuenta no encontrada" });
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
