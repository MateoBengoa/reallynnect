import type { SupabaseClient } from "@supabase/supabase-js";
import { getRedis, isMemoryRedis, type RedisClient } from "../queues/redisClient.js";
import { mapApifyItemToLeadInsert, runLeadActorAndFetchItems } from "./apifyLeadFinder.js";

const APIFY_USER_LOCK_KEY = (userId: string) => `apify:lead_import:user:${userId}`;
const LOCK_TTL_SEC = 7200;

export type ExecuteApifyLeadImportOpts = {
  sb: SupabaseClient;
  userId: string;
  campaignId: string | null;
  apifyToken: string;
  actorId: string;
  apifyInput: Record<string, unknown>;
  maxWaitMs: number;
  insertCap: number;
};

export type ExecuteApifyLeadImportResult = {
  newLeads: number;
  rowsWithLinkedIn: number;
  datasetSize: number;
  photosResolved: number;
};

/** Una sola ejecución Apify por usuario y proceso (evita N runs simultáneos si el worker paraleliza tareas). */
export class ApifyImportInFlightError extends Error {
  constructor() {
    super("Ya hay una importación Apify en curso para tu cuenta. Espera a que termine antes de lanzar otra.");
    this.name = "ApifyImportInFlightError";
  }
}

/** Solo cola en memoria: cerrojo por proceso (API y worker van aparte). */
const apifyImportActiveUserIds = new Set<string>();

export function isApifyImportInFlightError(e: unknown): boolean {
  return e instanceof Error && e.name === "ApifyImportInFlightError";
}

async function tryAcquireApifyLock(redis: RedisClient, userId: string): Promise<"redis" | "memory" | null> {
  if (!isMemoryRedis(redis)) {
    const ok = await redis.set(APIFY_USER_LOCK_KEY(userId), "1", "EX", LOCK_TTL_SEC, "NX");
    return ok === "OK" ? "redis" : null;
  }
  if (apifyImportActiveUserIds.has(userId)) return null;
  apifyImportActiveUserIds.add(userId);
  return "memory";
}

async function releaseApifyLock(redis: RedisClient, userId: string, kind: "redis" | "memory"): Promise<void> {
  if (kind === "redis" && !isMemoryRedis(redis)) {
    await redis.del(APIFY_USER_LOCK_KEY(userId)).catch(() => {});
    return;
  }
  apifyImportActiveUserIds.delete(userId);
}

async function executeApifyLeadImportCore(opts: ExecuteApifyLeadImportOpts): Promise<ExecuteApifyLeadImportResult> {
  const items = await runLeadActorAndFetchItems({
    token: opts.apifyToken,
    actorId: opts.actorId,
    input: opts.apifyInput,
    maxWaitMs: opts.maxWaitMs,
    pollMs: 10_000,
  });

  /* ── Debug: loguear claves del primer ítem para ver si hay campo de foto ── */
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
    const firstItem = items[0] as Record<string, unknown>;
    const keys = Object.keys(firstItem);
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[apify_lead_import] ===== PRIMER ÍTEM DEL DATASET (${keys.length} claves) =====`);
    // Loguear JSON completo (truncado a 3KB)
    const fullJson = JSON.stringify(firstItem, null, 2);
    console.log(`[apify_lead_import] JSON completo:\n${fullJson.substring(0, 3000)}`);
    if (fullJson.length > 3000) console.log(`[apify_lead_import] ... (truncado, ${fullJson.length} chars total)`);
    
    // Buscar campos de foto específicamente
    const photoKeys = keys.filter(
      (k) => /photo|image|picture|avatar|headshot|thumbnail|img/i.test(k)
    );
    if (photoKeys.length) {
      console.log(`[apify_lead_import] 📸 Claves de foto: ${photoKeys.map((k) => `${k}=${JSON.stringify(firstItem[k])}`).join(", ")}`);
    } else {
      console.log(`[apify_lead_import] ⚠ NO se encontraron claves de foto en el primer nivel`);
      // Buscar en objetos anidados
      for (const nk of ["person", "contact", "data", "profile", "lead"]) {
        const inner = firstItem[nk];
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          const innerKeys = Object.keys(inner as object).filter(
            (k) => /photo|image|picture|avatar|headshot|thumbnail|img/i.test(k)
          );
          if (innerKeys.length) {
            console.log(`[apify_lead_import] 📸 Claves de foto en "${nk}": ${innerKeys.map((k) => `${k}=${JSON.stringify((inner as Record<string, unknown>)[k])}`).join(", ")}`);
          }
        }
      }
    }
    console.log(`${"=".repeat(80)}\n`);
  }

  const mapped = items
    .map((it) => mapApifyItemToLeadInsert(it))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, opts.insertCap);

  if (!mapped.length) {
    const sample = items[0];
    const hint =
      sample && typeof sample === "object"
        ? ` Claves del primer ítem: ${Object.keys(sample as object).slice(0, 40).join(", ")}.`
        : "";
    throw new Error(`Apify devolvió 0 leads con URL de perfil LinkedIn válida (${items.length} ítems en dataset).${hint}`);
  }

  let newLeads = 0;
  const nextRun = new Date().toISOString();
  const { sb, userId, campaignId } = opts;
  /** Leads nuevos sin foto → resolver públicamente tras el insert. */
  const leadsNeedingPhoto: { id: string; profile_url: string }[] = [];

  for (const row of mapped) {
    const { data: existing } = await sb
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("profile_url", row.profile_url)
      .maybeSingle();
    let leadId = existing?.id as string | undefined;
    if (!leadId) {
      const { data: leadRow, error: insLead } = await sb
        .from("leads")
        .insert({
          profile_url: row.profile_url,
          user_id: userId,
          name: row.name ?? null,
          company: row.company ?? null,
          title: row.title ?? null,
          headline: row.headline ?? null,
          email: row.email ?? null,
          phone: row.phone ?? null,
          location: row.location ?? null,
          website: row.website ?? null,
          photo_url: row.photo_url ?? null,
          notes: row.notes ?? null,
          source: row.source ?? "apify_lead_finder",
        })
        .select("id")
        .single();
      if (insLead || !leadRow) continue;
      leadId = leadRow.id as string;
      newLeads++;
      if (!row.photo_url) {
        leadsNeedingPhoto.push({ id: leadId, profile_url: row.profile_url });
      }
    }
    if (campaignId && leadId) {
      const { error: enErr } = await sb.from("campaign_enrollments").insert({
        campaign_id: campaignId,
        lead_id: leadId,
        current_step_index: 0,
        next_run_at: nextRun,
        status: "paused",
        crm_status: "not_contacted",
      });
      void enErr;
    }
  }

  /* ── Fotos se resuelven en el harvestapi directamente, nada más que hacer ── */
  let photosResolved = 0;

  return { newLeads, rowsWithLinkedIn: mapped.length, datasetSize: items.length, photosResolved };
}

/**
 * Ejecuta el actor Apify, mapea ítems e inserta leads (+ inscripción opcional en campaña).
 * Un solo run activo por usuario: con Redis el cerrojo es global (API + worker); en cola en memoria, por proceso.
 */
export async function executeApifyLeadImport(opts: ExecuteApifyLeadImportOpts): Promise<ExecuteApifyLeadImportResult> {
  const redis = getRedis();
  const uid = opts.userId;
  const acquired = await tryAcquireApifyLock(redis, uid);
  if (acquired === null) {
    throw new ApifyImportInFlightError();
  }
  try {
    return await executeApifyLeadImportCore(opts);
  } finally {
    await releaseApifyLock(redis, uid, acquired);
  }
}
