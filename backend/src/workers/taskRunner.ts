import {
  closeSession,
  createContext,
  injectLiAt,
  ensureLinkedInFeedSession,
  publishPost,
  scrapeLoggedInMemberProfile,
  scrapeLoggedInMemberActivityPosts,
  followProfile,
  likeLeadRecentPost,
  commentLeadRecentPost,
  replyToCommentOnLeadRecentPost,
  sendConnectionRequest,
  sendMessageToProfile,
  sendMessageToOpenProfile,
  sendVoiceNoteToProfile,
  sendInMailToProfile,
  sessionWarmup,
  visitProfile,
  sendMessageInMessagingThread,
  normalizeMessagingThreadInput,
  ensureProfilePageLoaded,
  scrapeProfileDom,
} from "@linkedin-saas/automation";
import type { ScrapeActivityPostsResult } from "@linkedin-saas/automation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_BROWSERS,
  acquireBrowserSlot,
  checkUnderDailyCap,
  checkUnderHourlyCap,
  incrementDailyCount,
  incrementHourlyCount,
  enqueueTaskDue,
  popDueTaskIds,
  releaseBrowserSlot,
  removeTaskFromDue,
  setAccountCooldown,
  getAccountCooldownSec,
} from "../queues/redisClient.js";
import type { LimitKind, RedisClient } from "../queues/redisClient.js";
import { decryptSecret } from "../lib/crypto.js";
import { dispatchTaskWebhook } from "../lib/taskWebhook.js";
import { advanceEnrollmentAfterStep, failEnrollmentAfterDeadTask } from "../services/campaignEngine.js";
import { generateConnectionMessage, generateDmReply, generateImageBytes } from "../services/gemini.js";
import { loadProxy, markProxyDegraded, markProxyUsed, pickProxyForAccount } from "../services/proxyAssign.js";
import { enrichWorkerFailureMessage, startPlaywrightTraceIfConfigured, type TraceController } from "./linkedinRunContext.js";
import { parseLinkedInInboxListTime } from "../lib/linkedinInboxListTime.js";

const MAX_ATTEMPTS = 5;

async function persistLeadProfilePhotoFromOpenPage(
  sb: SupabaseClient,
  page: Page,
  opts: { leadId: string | null | undefined; accountUserId: string; profileUrl: string }
): Promise<void> {
  const { leadId, accountUserId, profileUrl } = opts;
  if (!leadId?.trim()) return;
  try {
    const low = profileUrl.toLowerCase();
    if (!low.includes("linkedin.com") || !low.includes("/in/")) return;
    const dom = await scrapeProfileDom(page);
    const photo = dom.photoUrl?.trim();
    if (!photo || (!photo.startsWith("http://") && !photo.startsWith("https://"))) return;
    const { data: row } = await sb.from("leads").select("user_id").eq("id", leadId).maybeSingle();
    if (!row || (row.user_id as string) !== accountUserId) return;
    await sb.from("leads").update({ photo_url: photo }).eq("id", leadId).eq("user_id", accountUserId);
  } catch (e) {
    console.warn("[worker] persistLeadProfilePhotoFromOpenPage", e instanceof Error ? e.message : e);
  }
}

/** `message_template` como `data:audio/...;base64,...` para el paso `voice_note`. */
async function writeVoiceDataUrlToTempFile(taskId: string, dataUrl: string): Promise<string | null> {
  const m = dataUrl.trim().match(/^data:([^;]+);base64,([\s\S]+)$/i);
  if (!m) return null;
  const b64 = m[2].replace(/\s/g, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (buf.length < 16) return null;
  if (buf.length > 5 * 1024 * 1024) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes("webm")
    ? "webm"
    : mime.includes("wav")
      ? "wav"
      : mime.includes("mpeg") || mime.includes("mp3")
        ? "mp3"
        : "bin";
  const tmp = path.join(os.tmpdir(), `li-voice-${taskId}.${ext}`);
  await fs.writeFile(tmp, buf);
  return tmp;
}

const colMissingLockedAt = (msg: string | undefined) =>
  Boolean(msg && (msg.includes("locked_at") || msg.includes("schema cache")));

/** Menor número = antes en la cola (campañas antes que poll automático). */
function taskDispatchGroup(action: string, enrollmentId: unknown): number {
  if (enrollmentId) return 0;
  if (action === "verify_session" || action === "session_check" || action === "sync_profile") return 1;
  if (
    action === "visit_profile" ||
    action === "sync_lead_photo" ||
    action === "batch_sync_lead_photos" ||
    action === "follow" ||
    action === "like_post" ||
    action === "comment_post" ||
    action === "connect" ||
    action === "send_message" ||
    action === "send_message_open_profile" ||
    action === "voice_note" ||
    action === "reply_comment" ||
    action === "inmail"
  )
    return 2;
  if (action === "publish_post") return 2;
  if (action === "warmup_feed") return 4;
  if (action === "import_leads") return 2;
    if (
      action === "poll_messages" ||
      action === "poll_comments" ||
      action === "sync_inbox" ||
      action === "sync_inbox_thread" ||
      action === "sync_linkedin_posts"
    )
      return 10;
    if (action === "reply_dm") return 2;
  return 3;
}

async function runPollWithTimeout<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
    run()
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

function inboxEnvInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Máximo de conversaciones a volcar en `inbox_conversations` por sync de lista. */
function inboxSyncMaxThreads(): number {
  return inboxEnvInt("INBOX_SYNC_MAX_THREADS", 500);
}

/** Hilos en poll_messages (suele ser menor que sync manual). */
function inboxPollMessagesMaxThreads(): number {
  const v = Number(process.env.INBOX_POLL_MESSAGES_MAX_THREADS);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  return Math.min(45, inboxSyncMaxThreads());
}

/** Timeout sync inbox: env o derivado de hilos × ms/hilo. */
function inboxSyncPollMs(maxThreads: number): number {
  const env = Number(process.env.INBOX_SYNC_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 120_000) return env;
  const perThread = inboxEnvInt("INBOX_SYNC_MS_PER_THREAD", 2100);
  return Math.max(360_000, 80_000 + maxThreads * perThread);
}

function inboxPollMessagesPollMs(maxThreads: number): number {
  const base = Number(process.env.POLL_TASK_TIMEOUT_MS ?? 130_000);
  const perThread = inboxEnvInt("INBOX_SYNC_MS_PER_THREAD", 2100);
  return Math.max(Number.isFinite(base) ? base : 130_000, 110_000 + maxThreads * perThread);
}

/** Timeout para abrir un hilo y volcar burbujas (sync bajo demanda). */
function inboxThreadSyncPollMs(): number {
  const env = Number(process.env.INBOX_THREAD_SYNC_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 60_000) return env;
  return 240_000;
}

async function extractConversationIdFromMessagingUrl(page: Page): Promise<string | null> {
  try {
    const u = page.url();
    const m = u.match(/\/messaging\/thread\/([^/?#]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    /* ignore */
  }
  return null;
}

/** LinkedIn a veces deja la URL en /messaging/; el id del hilo va en el panel o en data-URLs del HTML. */
async function extractThreadIdFromMessagingPane(page: Page): Promise<string | null> {
  const scoped = page.locator(".msg-s-message-list, .msg-s-message-list-container, .msg-thread").first();
  if (await scoped.isVisible({ timeout: 2500 }).catch(() => false)) {
    const id = (await scoped
      .evaluate(
        `root => {
          var walk = root.parentElement || root;
          var main = walk.closest("main");
          var html = (main && main.innerHTML) || walk.innerHTML || "";
          var i = html.indexOf("/messaging/thread/");
          if (i < 0) return "";
          var rest = html.slice(i + "/messaging/thread/".length);
          var end = rest.search(/["'\\s<>?#]/);
          var raw = end < 0 ? rest : rest.slice(0, end);
          try { return decodeURIComponent(raw); } catch (e) { return raw; }
        }`
      )
      .catch(() => "")) as string;
    if (id) return id;
  }
  const fromMain = (await page
    .evaluate(
      `() => {
        var main = document.querySelector("main");
        var html = (main && main.innerHTML) || document.body.innerHTML || "";
        var i = html.indexOf("/messaging/thread/");
        if (i < 0) return "";
        var rest = html.slice(i + "/messaging/thread/".length);
        var end = rest.search(/["'\\s<>?#]/);
        var raw = end < 0 ? rest : rest.slice(0, end);
        try { return decodeURIComponent(raw); } catch (e) { return raw; }
      }`
    )
    .catch(() => null)) as string | null;
  return fromMain || null;
}

type InboxListRow = {
  conversationId: string;
  peerName: string | null;
  preview: string;
  peerPhotoUrl: string | null;
  /** ISO 8601: fecha/hora del último mensaje según la fila de lista de LinkedIn */
  lastActivityAtIso?: string | null;
};

function resolveListRowActivityIso(
  row: { timeStampRaw?: string; timeStampText?: string },
  ref: Date
): string | undefined {
  const tr = (row.timeStampRaw ?? "").trim();
  if (tr) {
    if (/^\d{10,13}$/.test(tr)) {
      const n = parseInt(tr, 10);
      const d = new Date(tr.length >= 13 ? n : n * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const d = new Date(tr);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const iso = parseLinkedInInboxListTime(String(row.timeStampText ?? ""), ref);
  return iso ?? undefined;
}

/** Una sola pasada por el DOM: regex de thread en cada fila (LinkedIn no siempre usa <a visible>). */
async function extractInboxRowsFromListDom(page: Page, max: number): Promise<InboxListRow[]> {
  try {
    const raw = await page.evaluate(
      `maxN => {
      function threadFrom(s) {
        if (!s) return "";
        var i = s.indexOf("/messaging/thread/");
        if (i < 0) return "";
        var rest = s.slice(i + "/messaging/thread/".length);
        var end = rest.search(/["'\\s<>?#]/);
        var raw = end < 0 ? rest : rest.slice(0, end);
        try { return decodeURIComponent(raw); } catch (e) { return raw; }
      }
      var out = [];
      var seen = new Set();
      var rowEls = [];
      var sels = [
        '[data-view-name="message-list-item"]',
        '[data-view-name="message-list-item-conversation"]',
        ".msg-conversation-listitem",
        ".msg-conversations-container__conversations-list > li",
        "ul.msg-conversations-container__conversations-list li",
        'aside [role="listitem"]',
        "aside li"
      ];
      for (var si = 0; si < sels.length; si++) {
        document.querySelectorAll(sels[si]).forEach(function (el) {
          if (rowEls.indexOf(el) >= 0) return;
          if (el.closest(".msg-s-message-list-container")) return;
          if (el.closest("[data-view-name='message-pane']")) return;
          rowEls.push(el);
        });
      }
      for (var ri = 0; ri < rowEls.length; ri++) {
        if (out.length >= maxN) break;
        var row = rowEls[ri];
        var html = row.outerHTML;
        var conversationId = threadFrom(html);
        if (!conversationId) {
          var a = row.querySelector("a[href*='/messaging/thread/']");
          if (a && a.href) conversationId = threadFrom(a.href);
        }
        if (!conversationId) {
          var attrNodes = row.querySelectorAll("a[href], [data-href], [data-item-id]");
          for (var ai = 0; ai < attrNodes.length && !conversationId; ai++) {
            var node = attrNodes[ai];
            ["href", "data-href", "data-item-id"].forEach(function (attr) {
              if (conversationId) return;
              var v = node.getAttribute(attr);
              if (v && v.indexOf("/messaging/thread/") >= 0) conversationId = threadFrom(v);
            });
          }
        }
        if (!conversationId || seen.has(conversationId)) continue;
        seen.add(conversationId);
        var nameEl =
          row.querySelector(".msg-conversation-listitem__participant-names") ||
          row.querySelector("[class*='participant-names']") ||
          row.querySelector("h3, .truncate");
        var nt = nameEl ? (nameEl.textContent != null ? String(nameEl.textContent) : "") : "";
        var peerName = nt ? nt.replace(/\\s+/g, " ").trim().slice(0, 200) : null;
        // Intentar extraer solo el texto del snippet (sin nombre ni timestamp)
        var snippetEl =
          row.querySelector(".msg-conversation-card__message-snippet") ||
          row.querySelector("[class*='message-snippet']") ||
          row.querySelector("[class*='preview']") ||
          row.querySelector("[class*='snippet']") ||
          row.querySelector("p[class*='subline']");
        var preview;
        if (snippetEl && snippetEl.textContent) {
          preview = String(snippetEl.textContent).replace(/\\s+/g, " ").trim().slice(0, 300);
        } else {
          preview = String(row.textContent != null ? row.textContent : "").replace(/\\s+/g, " ").trim().slice(0, 300);
        }
        // Fotos: probar varios atributos de lazy-load de LinkedIn
        var photo = null;
        var imgs = row.querySelectorAll("img");
        for (var ii = 0; ii < imgs.length; ii++) {
          var imgEl = imgs[ii];
          var pu = imgEl.getAttribute("data-delayed-url") || imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "";
          if (pu.indexOf("http") === 0 && pu.indexOf("data:") !== 0 && pu.indexOf("ghost") < 0) {
            photo = pu;
            break;
          }
        }
        if (!photo) {
          // Intentar picture > source (LinkedIn usa picture element a veces)
          var src = row.querySelector("picture source");
          if (src) {
            var ss = src.getAttribute("srcset") || src.getAttribute("data-srcset") || "";
            var firstSrc = ss.split(",")[0];
            if (firstSrc) {
              var su = firstSrc.trim().split(" ")[0];
              if (su && su.indexOf("http") === 0) photo = su;
            }
          }
        }
        out.push({ conversationId: conversationId, peerName: peerName, preview: preview || "—", peerPhotoUrl: photo });
      }
      return out;
    }`,
      max
    );
    return Array.isArray(raw) ? (raw as InboxListRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Filas de la lista en orden visual de LinkedIn (arriba = más reciente): solo `ul.msg-conversations-container__conversations-list > li`.
 */
async function extractInboxRowsFromOrderedListDom(page: Page, max: number): Promise<InboxListRow[]> {
  const ref = new Date();
  try {
    const raw = await page.evaluate(
      `maxN => {
        function threadFrom(s) {
          if (!s) return "";
          var i = s.indexOf("/messaging/thread/");
          if (i < 0) return "";
          var rest = s.slice(i + "/messaging/thread/".length);
          var end = rest.search(/["'\\s<>?#]/);
          var rawId = end < 0 ? rest : rest.slice(0, end);
          try { return decodeURIComponent(rawId); } catch (e) { return rawId; }
        }
        function normPreview(t) {
          return (t == null ? "" : String(t)).replace(/\\s+/g, " ").trim();
        }
        var ul = document.querySelector("ul.msg-conversations-container__conversations-list");
        if (!ul) return [];
        var out = [];
        var lis = ul.querySelectorAll(":scope > li");
        for (var i = 0; i < lis.length && out.length < maxN; i++) {
          var row = lis[i];
          if (!row.querySelector(".msg-conversation-card, .msg-conversation-listitem")) continue;
          var html = row.outerHTML;
          var conversationId = threadFrom(html);
          if (!conversationId) {
            var a = row.querySelector("a[href*='/messaging/thread/']");
            if (a && a.href) conversationId = threadFrom(a.href);
          }
          if (!conversationId) {
            var nodes = row.querySelectorAll("a[href], [data-href]");
            for (var ai = 0; ai < nodes.length && !conversationId; ai++) {
              var v = nodes[ai].getAttribute("href") || nodes[ai].getAttribute("data-href");
              if (v && v.indexOf("/messaging/thread/") >= 0) conversationId = threadFrom(v);
            }
          }
          if (!conversationId) continue;
          var nameEl =
            row.querySelector(".msg-conversation-listitem__participant-names") ||
            row.querySelector("[class*='participant-names']") ||
            row.querySelector("h3, .truncate");
          var nt = nameEl ? String(nameEl.textContent || "") : "";
          var peerName = nt ? nt.replace(/\\s+/g, " ").trim().slice(0, 200) : null;
          var snippetEl =
            row.querySelector(".msg-conversation-card__message-snippet") ||
            row.querySelector("[class*='message-snippet']");
          var preview = snippetEl
            ? normPreview(snippetEl.textContent).slice(0, 300)
            : normPreview(row.textContent).slice(0, 300);
          var photo = null;
          var imgs = row.querySelectorAll("img");
          for (var ii = 0; ii < imgs.length; ii++) {
            var imgEl = imgs[ii];
            var pu = imgEl.getAttribute("data-delayed-url") || imgEl.getAttribute("data-src") || imgEl.src || "";
            if (pu.indexOf("http") === 0 && pu.indexOf("data:") !== 0 && pu.indexOf("ghost") < 0) {
              photo = pu;
              break;
            }
          }
          var timeStampRaw = "";
          var timeStampText = "";
          var tsEl = row.querySelector(
            "time.msg-conversation-card__time-stamp, time.msg-conversation-listitem__time-stamp, " +
            ".msg-conversation-card__time-stamp, .msg-conversation-listitem__time-stamp"
          );
          if (tsEl) {
            timeStampRaw =
              tsEl.getAttribute("datetime") ||
              tsEl.getAttribute("data-time") ||
              (tsEl.closest("[data-time]") && tsEl.closest("[data-time]").getAttribute("data-time")) ||
              "";
            timeStampText = normPreview(tsEl.textContent);
          }
          if (!timeStampRaw) {
            var dtn = row.querySelector("[data-time]");
            if (dtn) timeStampRaw = dtn.getAttribute("data-time") || "";
          }
          out.push({
            conversationId: conversationId,
            peerName: peerName,
            preview: preview || "—",
            peerPhotoUrl: photo,
            timeStampRaw: timeStampRaw,
            timeStampText: timeStampText
          });
        }
        return out;
      }`,
      max
    );
    if (!Array.isArray(raw)) return [];
    type RawInboxListEvalRow = {
      conversationId: string;
      peerName: string | null;
      preview: string;
      peerPhotoUrl: string | null;
      timeStampRaw?: string;
      timeStampText?: string;
    };
    return (raw as RawInboxListEvalRow[]).map((r) => ({
      conversationId: r.conversationId,
      peerName: r.peerName,
      preview: r.preview,
      peerPhotoUrl: r.peerPhotoUrl,
      lastActivityAtIso: resolveListRowActivityIso(r, ref) ?? null,
    }));
  } catch {
    return [];
  }
}

async function upsertInboxConversationRows(sb: SupabaseClient, accountId: string, rows: InboxListRow[]): Promise<void> {
  if (!rows.length) return;
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    account_id: accountId,
    conversation_id: r.conversationId,
    peer_name: r.peerName ?? null,
    peer_photo_url: r.peerPhotoUrl ?? null,
    list_preview: (r.preview ?? "—").trim().slice(0, 500) || "—",
    list_last_activity_at: r.lastActivityAtIso ?? null,
    updated_at: now,
  }));
  const { error } = await sb.from("inbox_conversations").upsert(payload, { onConflict: "account_id,conversation_id" });
  if (error) console.error("[inbox_sync] upsert inbox_conversations:", error.message);
}

async function upsertInboxConversationOne(
  sb: SupabaseClient,
  accountId: string,
  row: {
    conversation_id: string;
    peer_name?: string | null;
    peer_photo_url?: string | null;
    list_preview?: string | null;
    linkedin_updated_at?: string | null;
    list_rank?: number | null;
    list_last_activity_at?: string | null;
  }
): Promise<void> {
  const preview = (row.list_preview ?? "—").trim().slice(0, 500) || "—";
  const updatedAt = row.linkedin_updated_at ?? new Date().toISOString();
  const payload: Record<string, unknown> = {
    account_id: accountId,
    conversation_id: row.conversation_id,
    peer_name: row.peer_name ?? null,
    peer_photo_url: row.peer_photo_url ?? null,
    list_preview: preview,
    updated_at: updatedAt,
  };
  if (row.list_rank != null && Number.isFinite(row.list_rank)) payload.list_rank = row.list_rank;
  if (row.list_last_activity_at !== undefined) payload.list_last_activity_at = row.list_last_activity_at;
  const { error } = await sb.from("inbox_conversations").upsert(payload, { onConflict: "account_id,conversation_id" });
  if (error) console.error("[inbox_sync] upsert one inbox_conversations:", error.message);
}

/** Volcado masivo con orden de lista LinkedIn (list_rank 0 = más reciente arriba). */
async function bulkUpsertInboxConversationsOrdered(
  sb: SupabaseClient,
  accountId: string,
  rows: InboxListRow[],
  syncBaseTime: number
): Promise<void> {
  if (!rows.length) return;
  const n = rows.length;
  const chunk = inboxEnvInt("INBOX_BULK_UPSERT_CHUNK", 480);
  const parallel = Math.min(4, Math.max(1, inboxEnvInt("INBOX_BULK_UPSERT_PARALLEL", 2)));

  const upsertSlice = async (off: number, slice: InboxListRow[]): Promise<void> => {
    if (!slice.length) return;
    const payload = slice.map((r, j) => {
      const i = off + j;
      const preview = (r.preview ?? "—").trim().slice(0, 500) || "—";
      return {
        account_id: accountId,
        conversation_id: r.conversationId,
        peer_name: r.peerName ?? null,
        peer_photo_url: r.peerPhotoUrl ?? null,
        list_preview: preview,
        list_rank: i,
        list_last_activity_at: r.lastActivityAtIso ?? null,
        updated_at: new Date(syncBaseTime + (n - i) * 2000).toISOString(),
      };
    });
    const { error } = await sb.from("inbox_conversations").upsert(payload, { onConflict: "account_id,conversation_id" });
    if (error) console.error("[inbox_sync] bulk upsert inbox_conversations:", error.message);
  };

  for (let off = 0; off < rows.length; off += chunk * parallel) {
    const batch: Promise<void>[] = [];
    for (let p = 0; p < parallel; p++) {
      const start = off + p * chunk;
      if (start >= rows.length) break;
      batch.push(upsertSlice(start, rows.slice(start, start + chunk)));
    }
    await Promise.all(batch);
  }
  console.log(`[inbox_sync] bulk lista ordenada: ${rows.length} conversaciones (list_rank 0…${n - 1})`);
}

async function extractPeerNameFromMessagingThread(page: Page): Promise<string | null> {
  const loc = page.locator(
    '[data-test-id="conversation-header-name"], .msg-thread__link-to-profile, h2.msg-title-bar__title-bar-title, .msg-entity-lockup__entity-title'
  );
  const t = String((await loc.first().innerText().catch(() => "")) ?? "");
  const line = t.trim().split(/\n/)[0]?.trim();
  return line || null;
}

async function extractPeerPhotoUrlFromThread(page: Page): Promise<string | null> {
  // IMPORTANTE: usar IIFE (function(){ })() — el form () => {} retorna el objeto función sin ejecutar.
  // Buscar la foto del PEER en el panel derecho del hilo, NO en toda la página
  // (que también tiene el avatar del usuario en el navbar).
  const u = await page
    .evaluate(
      `(function() {
        function getImgUrl(el) {
          if (!el) return "";
          // Usar .src (propiedad JS, refleja cambios dinámicos) no getAttribute que da el HTML original
          var u = el.getAttribute("data-delayed-url") || el.getAttribute("data-src") || el.src || "";
          if (!u || u.indexOf("data:") === 0) return "";
          if (u.indexOf("http") === 0) return u;
          return "";
        }
        // 1. Primero en el panel del hilo (derecho) — evita confundir con avatares de la lista
        var panelSels = [
          ".msg-entity-lockup__entity-image img",
          ".msg-entity-lockup img",
          "[data-view-name='message-pane'] .msg-entity-lockup img",
          ".msg-thread__link-to-profile img",
          ".msg-thread__top-bar img",
          "header .msg-entity-lockup img"
        ];
        for (var pi = 0; pi < panelSels.length; pi++) {
          var el = document.querySelector(panelSels[pi]);
          if (!el) continue;
          var pu = getImgUrl(el);
          if (pu && pu.indexOf("media.licdn.com") >= 0) return pu;
        }
        // 2. Buscar en el panel del hilo específicamente (no toda la página)
        var pane = document.querySelector(
          "[data-view-name='message-pane'], .scaffold-layout__detail, .msg-thread, .msg-overlay-conversation-bubble"
        );
        if (pane) {
          var paneImgs = pane.querySelectorAll("img");
          for (var pi2 = 0; pi2 < paneImgs.length; pi2++) {
            var img = paneImgs[pi2];
            if (img.naturalWidth > 0 && img.src && img.src.indexOf("media.licdn.com") >= 0) return img.src;
          }
        }
        return "";
      })()`
    )
    .then((v) => String(v ?? "").trim())
    .catch(() => "");
  return u || null;
}

function normalizeMsgText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeLinkedInThreadDump(s: string): boolean {
  return (
    /ha enviado (el siguiente|los siguientes) mensaje/i.test(s) ||
    /\bVer el perfil de\b/i.test(s) ||
    /\bMeet meet\.google/i.test(s)
  );
}

/**
 * LinkedIn concatena toda la conversación en innerText: quita chrome y deja el último cuerpo útil.
 */
function extractLastBubbleFromLinkedInDump(raw: string): string {
  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const skipLine = (t: string) => {
    if (/^Ver el perfil de\b/i.test(t)) return true;
    if (/ha enviado (el siguiente|los siguientes) mensajes?\b/i.test(t)) return true;
    if (/^\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,15}\s+\d{4}$/.test(t)) return true;
    if (/^Meet meet\.google/i.test(t)) return true;
    if (t === "Descargar" || t === "Meet") return true;
    if (/^Reaccionar con\b/i.test(t)) return true;
    if (/^\d+(\.\d+)?\s*(KB|MB|GB)\b/i.test(t)) return true;
    if (/^https:\/\/meet\.google\.com\//i.test(t)) return true;
    return false;
  };
  const kept = lines.filter((l) => !skipLine(l));
  let joined = kept.join(" ");
  const timeSplits = joined.split(/\b\d{1,2}:\d{2}\b/);
  const tail = timeSplits.length > 1 ? timeSplits[timeSplits.length - 1]!.trim() : joined;
  let out = tail.length >= 12 ? tail : joined;
  out = out.replace(/^[\wÀ-ÿ\s,.'´`-]{2,90}?\s+(?=[¡¿"'(A-Z0-9])/u, "").trim();
  return normalizeMsgText(out).slice(0, 4000);
}

/** Texto listo para guardar en `messages` (evita volcados de accesibilidad de LinkedIn). */
function sanitizeForInboxDb(raw: string): string {
  const n = normalizeMsgText(raw);
  if (n.length < 3) return n;
  if (looksLikeLinkedInThreadDump(n) || n.length > 900) {
    const extracted = extractLastBubbleFromLinkedInDump(raw);
    if (extracted.length >= 8) return extracted;
  }
  return n.slice(0, 8000);
}

async function scrollThreadMessageListToBottom(page: Page): Promise<void> {
  const list = page
    .locator(
      ".msg-s-message-list-container, ul.msg-s-message-list, .msg-s-message-list, [class*='msg-s-message-list']"
    )
    .first();
  if (await list.isVisible({ timeout: 5000 }).catch(() => false)) {
    await list.evaluate(`el => { el.scrollTop = el.scrollHeight; }`).catch(() => {});
  }
  await page.keyboard.press("End").catch(() => {});
  await new Promise((r) => setTimeout(r, 450));
}

async function scrollThreadMessageListLoadOlder(page: Page): Promise<void> {
  const list = page
    .locator(
      ".msg-s-message-list-container, ul.msg-s-message-list, .msg-s-message-list, [class*='msg-s-message-list']"
    )
    .first();
  if (!(await list.isVisible({ timeout: 4000 }).catch(() => false))) return;
  await list.evaluate(`el => { el.scrollTop = 0; }`).catch(() => {});
  await new Promise((r) => setTimeout(r, 350));
  const rounds = inboxEnvInt("INBOX_THREAD_SCROLL_UP_ROUNDS", 18);
  for (let i = 0; i < rounds; i++) {
    await list.evaluate(`el => { el.scrollTop = Math.max(0, el.scrollTop - 700); }`).catch(() => {});
    await new Promise((r) => setTimeout(r, 140));
  }
  await scrollThreadMessageListToBottom(page);
}

type ThreadBubbleAttachment = { name: string; kind?: string; download_url?: string };

async function enrichBubblesWithAttachmentDownloadUrls(
  page: Page,
  bubbles: { attachments?: ThreadBubbleAttachment[] }[]
): Promise<void> {
  let totalAtt = 0;
  for (const b of bubbles) totalAtt += b.attachments?.length ?? 0;
  if (totalAtt === 0) return;

  const panel = page.locator(".msg-s-message-list-container, ul.msg-s-message-list").first();
  if (!(await panel.isVisible({ timeout: 4000 }).catch(() => false))) return;

  const buttons = panel.locator("button.msg-s-event-listitem__download-attachment-button");
  const btnCount = await buttons.count().catch(() => 0);
  if (btnCount === 0) return;

  const flatSlots: { b: number; a: number }[] = [];
  for (let bi = 0; bi < bubbles.length; bi++) {
    const ats = bubbles[bi].attachments;
    if (!ats?.length) continue;
    for (let ai = 0; ai < ats.length; ai++) flatSlots.push({ b: bi, a: ai });
  }

  const maxClicks = Math.min(btnCount, flatSlots.length, inboxEnvInt("INBOX_THREAD_ATTACHMENT_URL_MAX", 15));
  for (let i = 0; i < maxClicks; i++) {
    let url = "";
    try {
      const respPromise = page
        .waitForResponse(
          (r) => {
            const u = r.url();
            if (!u.startsWith("https://")) return false;
            if (!u.includes("licdn.com") && !u.includes("linkedin.com")) return false;
            const ct = (r.headers()["content-type"] ?? "").toLowerCase();
            return ct.includes("pdf") || ct.includes("octet-stream") || ct.includes("msword") || ct.includes("officedocument");
          },
          { timeout: 14_000 }
        )
        .catch(() => null);
      const dlPromise = page.waitForEvent("download", { timeout: 14_000 }).catch(() => null);
      await buttons.nth(i).click({ timeout: 5000 }).catch(() => {});
      const [dl, resp] = await Promise.all([dlPromise, respPromise]);
      if (dl) {
        url = dl.url();
        await dl.cancel().catch(() => {});
      } else if (resp && resp.ok()) {
        url = resp.url();
      }
    } catch {
      /* ignorar */
    }
    if (url && url.startsWith("http") && !url.startsWith("blob:")) {
      const slot = flatSlots[i];
      const list = bubbles[slot.b].attachments;
      if (list && list[slot.a]) list[slot.a].download_url = url;
    }
  }
}

function previewFromBubble(b: { text: string; attachments?: ThreadBubbleAttachment[] }): string {
  const t = sanitizeForInboxDb(b.text).trim();
  const att = (b.attachments ?? [])
    .map((a) => `📎 ${a.name}`)
    .join(" ");
  if (t && att) return `${t.slice(0, 140)} · ${att}`.slice(0, 220);
  if (t) return t.slice(0, 220);
  if (att) return att.slice(0, 220);
  return "—";
}

async function extractAllThreadBubblesFromDom(page: Page): Promise<
  { text: string; direction: "in" | "out"; attachments?: ThreadBubbleAttachment[] }[]
> {
  // IMPORTANTE: page.evaluate con string de arrow function retorna el objeto función (no serializable).
  // Usar siempre IIFE (function(){ ... })() para que se ejecute y devuelva el valor.
  try {
  const raw = await page.evaluate(`(function() {
    function norm(s) { return (s == null ? "" : String(s)).replace(/\\s+/g, " ").trim(); }
    function classStr(el) {
      if (!el) return "";
      var cn = el.className;
      if (typeof cn === "string") return cn;
      if (cn && typeof cn.baseVal === "string") return cn.baseVal;
      try { return cn != null ? String(cn) : ""; } catch (e) { return ""; }
    }
    function inConvList(el) {
      return el.closest(".msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list") !== null;
    }
    // DOM real LinkedIn (2025–2026): div.msg-s-event-listitem con data-view-name="message-list-item".
    // --other = mensaje del contacto (in); sin --other en ese div = mensaje propio (out).
    function fromSelf(eventListItem) {
      if (!eventListItem) return false;
      var cls = classStr(eventListItem);
      if (cls.indexOf("msg-s-event-listitem--other") >= 0) return false;
      if (/msg-s-event-listitem/.test(cls)) return true;
      var inner = eventListItem.querySelector(".msg-s-event-listitem");
      if (inner && classStr(inner).indexOf("msg-s-event-listitem--other") < 0) return true;
      return false;
    }
    function extractMsgText(eventItem) {
      // En HTML guardado de LinkedIn el texto va en p.msg-s-event-listitem__body (no __message-body)
      var bodyEl = eventItem.querySelector(
        "p.msg-s-event-listitem__body, p.msg-s-event-listitem__message-body, " +
        "[class*='msg-s-event-listitem__body'], .msg-s-event__content p, " +
        ".msg-s-event-listitem__message-bubble p, [class*='message-body']"
      );
      if (bodyEl) return norm(bodyEl.textContent || "");
      var firstP = eventItem.querySelector(".msg-s-event__content p, .msg-s-event-listitem__message-bubble p");
      if (firstP) return norm(firstP.textContent || "");
      return "";
    }
    // Adjuntos: p.ui-attachment__filename dentro de .msg-s-event-listitem__download-attachment-button / .ui-attachment--pdf|doc|…
    function extractAttachments(eventItem) {
      var out = [];
      var seen = {};
      var fnameEls = eventItem.querySelectorAll("p.ui-attachment__filename");
      for (var fi = 0; fi < fnameEls.length; fi++) {
        var name = norm(fnameEls[fi].textContent || "");
        if (name.length < 2) continue;
        if (seen[name]) continue;
        seen[name] = true;
        var wrap = fnameEls[fi].closest(".ui-attachment, .msg-s-event-listitem__attachment-type");
        var kind = "";
        if (wrap) {
          var m = classStr(wrap).match(/ui-attachment--([a-z0-9_-]+)/i);
          if (m) kind = m[1];
        }
        out.push({ name: name.slice(0, 500), kind: kind || undefined });
      }
      return out;
    }

    // 1. Buscar el contenedor raíz del hilo de mensajes (NO la lista de conversaciones)
    var threadRoots = [
      ".msg-s-message-list-container",
      "ul.msg-s-message-list",
      ".msg-s-message-list",
      "[data-view-name='message-thread-scroll-container']",
      "[data-view-name='message-pane']",
      ".scaffold-layout__detail",
      ".msg-thread"
    ];
    var root = null;
    for (var ri = 0; ri < threadRoots.length; ri++) {
      var r = document.querySelector(threadRoots[ri]);
      if (r && !inConvList(r)) { root = r; break; }
    }
    if (!root) {
      var detailInner = document.querySelector(".scaffold-layout__detail-inner");
      root = (detailInner && !inConvList(detailInner)) ? detailInner : null;
    }
    // Fallback solo si ningún contenedor específico fue encontrado
    if (!root) root = document.querySelector("main") || document.body;

    // 2. Ítems de mensaje: priorizar data-view-name="message-list-item" (coincide con HTML exportado)
    var itemSelectors = [
      "[data-view-name='message-list-item'].msg-s-event-listitem",
      "div.msg-s-event-listitem[data-view-name='message-list-item']",
      "[data-view-name='message-list-item']",
      "li.msg-s-message-list__event",
      "li[class*='msg-s-message-list__event']",
      ".msg-s-event-listitem",
      "[data-view-name='message-list-item-event']",
      "[data-view-name='message-event']"
    ];
    var items = [];
    for (var si = 0; si < itemSelectors.length; si++) {
      var found = Array.prototype.slice.call(root.querySelectorAll(itemSelectors[si])).filter(function(el) { return !inConvList(el); });
      if (found.length > 0) { items = found; break; }
    }

    // 3. Si no se encontraron ítems con selectores específicos, buscar por estructura
    if (items.length === 0) {
      // Buscar li o div que contengan p con texto de mensaje o adjunto
      items = Array.prototype.slice.call(root.querySelectorAll("li, div[class*='event'], div[class*='message']")).filter(function(el) {
        if (inConvList(el)) return false;
        if (el.querySelector("p.ui-attachment__filename")) return true;
        var ps = el.querySelectorAll("p");
        for (var pi = 0; pi < ps.length; pi++) {
          if (norm(ps[pi].textContent || "").length >= 3) return true;
        }
        return false;
      });
    }

    // 4. Texto, adjuntos y dirección (no deduplicar por texto)
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var bubbleRoot = item.matches && item.matches(".msg-s-event-listitem") ? item : item.querySelector(".msg-s-event-listitem");
      var t = extractMsgText(item);
      var atts = extractAttachments(item);
      if (t.length < 2 && atts.length === 0) continue;
      var self = fromSelf(bubbleRoot || item);
      out.push({
        text: t.slice(0, 8000),
        direction: self ? "out" : "in",
        attachments: atts.length ? atts : undefined
      });
    }
    return out;
  })()`);
  return Array.isArray(raw)
    ? (raw as { text: string; direction: "in" | "out"; attachments?: ThreadBubbleAttachment[] }[])
    : [];
  } catch (e) {
    console.warn("[inbox_thread_sync] extractAllThreadBubblesFromDom:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

type DmRuleRow = { id: string; keyword: string; reply_template: string | null; use_ai: boolean };

async function runMessagingThreadSync(
  page: Page,
  sb: SupabaseClient,
  accountId: string,
  userId: string,
  conversationId: string,
  opts: { keywordsAutoReply: boolean }
): Promise<void> {
  const url = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(conversationId)}/`;
  // 'load' espera el JS inicial; los mensajes se cargan después con XHR
  await page.goto(url, { waitUntil: "load", timeout: 55_000 }).catch(() =>
    page.goto(url, { waitUntil: "domcontentloaded", timeout: 55_000 })
  );
  await new Promise((r) => setTimeout(r, 1000));
  // Esperar hasta que aparezca al menos un elemento de mensaje en el DOM
  await page
    .waitForFunction(
      `(function() {
        var sels = [
          "[data-view-name='message-list-item']",
          ".msg-s-event-listitem",
          "li.msg-s-message-list__event",
          "[data-view-name='message-list-item-event']",
          "[data-view-name='message-event']",
          "li[class*='msg-s-message-list__event']"
        ];
        for (var i = 0; i < sels.length; i++) {
          if (document.querySelector(sels[i])) return true;
        }
        return false;
      })()`
    , { timeout: 20_000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  await scrollThreadMessageListLoadOlder(page);
  await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_THREAD_DOM_SETTLE_MS", 1500)));
  let bubbles = await extractAllThreadBubblesFromDom(page);
  console.log(`[inbox_thread_sync] thread=${conversationId.slice(0, 14)}… burbujas_intento1=${bubbles.length}`);
  if (bubbles.length < 2) {
    // Diagnóstico: listar qué contenedores y elementos existen en el DOM del hilo
    const dbgInfo = await page.evaluate(`(function() {
      var candidates = [
        ".msg-s-message-list-container", ".msg-s-message-list", ".msg-thread",
        "[data-view-name='message-thread-scroll-container']", "[data-view-name='message-pane']",
        ".scaffold-layout__detail", "main"
      ];
      var found = [];
      for (var i = 0; i < candidates.length; i++) {
        var el = document.querySelector(candidates[i]);
        if (el) {
          var li = el.querySelectorAll("li").length;
          var art = el.querySelectorAll("article").length;
          var p = el.querySelectorAll("p").length;
          found.push(candidates[i] + "(li=" + li + ",art=" + art + ",p=" + p + ")");
        }
      }
      var msgSItems = document.querySelectorAll("[class*='msg-s']");
      var msgClasses = [];
      for (var mi = 0; mi < Math.min(5, msgSItems.length); mi++) {
        var cn = msgSItems[mi].className;
        msgClasses.push(typeof cn === "string" ? cn.split(" ")[0] : "?");
      }
      return "url=" + window.location.href.slice(-40) + " | found=" + found.join(";") + " | msg-s-classes=" + msgClasses.join(",");
    })()`).catch(() => "eval-err");
    console.log("[inbox_thread_sync] DOM diagnóstico:", dbgInfo);
    await new Promise((r) => setTimeout(r, 1500));
    bubbles = await extractAllThreadBubblesFromDom(page);
    console.log(`[inbox_thread_sync] thread=${conversationId.slice(0, 14)}… burbujas_intento2=${bubbles.length}`);
  }

  await enrichBubblesWithAttachmentDownloadUrls(page, bubbles);

  const peerName = (await extractPeerNameFromMessagingThread(page))?.trim() || null;
  const peerPhotoUrl = await extractPeerPhotoUrlFromThread(page);
  const lastBubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
  const listPreview = lastBubble ? previewFromBubble(lastBubble) : "—";
  await upsertInboxConversationOne(sb, accountId, {
    conversation_id: conversationId,
    peer_name: peerName,
    peer_photo_url: peerPhotoUrl,
    list_preview: listPreview,
  });

  const baseTs = Date.now() - Math.max(0, bubbles.length - 1) * inboxEnvInt("INBOX_THREAD_MESSAGE_STEP_MS", 60_000);
  const stepMs = inboxEnvInt("INBOX_THREAD_MESSAGE_STEP_MS", 60_000);
  const rows = bubbles
    .map((b, idx) => {
      const text = sanitizeForInboxDb(b?.text).trim();
      const attachments =
        Array.isArray(b.attachments) && b.attachments.length > 0 ? b.attachments : null;
      if (!text && !attachments?.length) return null;
      return {
        account_id: accountId,
        conversation_id: conversationId,
        message_text: text ? text.slice(0, 8000) : null,
        attachments,
        direction: b.direction,
        peer_name: peerName,
        peer_photo_url: peerPhotoUrl,
        created_at: new Date(baseTs + idx * stepMs).toISOString(),
      };
    })
    .filter(Boolean) as Record<string, unknown>[];

  if (rows.length === 0) {
    console.warn(
      `[inbox_thread_sync] thread=${conversationId.slice(0, 12)}… sin burbujas persistibles; se mantiene messages existente`
    );
    return;
  }

  const { error: delErr } = await sb.from("messages").delete().eq("account_id", accountId).eq("conversation_id", conversationId);
  if (delErr) {
    console.error("[inbox_thread_sync] delete messages:", delErr.message);
    throw new Error(delErr.message);
  }

  const { error: insErr } = await sb.from("messages").insert(rows);
  if (insErr) {
    console.error("[inbox_thread_sync] insert messages:", insErr.message);
    throw new Error(insErr.message);
  }
  console.log(`[inbox_thread_sync] thread=${conversationId.slice(0, 12)}… burbujas=${rows.length}`);

  if (!opts.keywordsAutoReply || !rows.length) return;
  const { data: rulesRaw } = await sb
    .from("keyword_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("rule_type", "dm")
    .eq("is_active", true);
  const rules = (rulesRaw ?? []) as DmRuleRow[];
  if (!rules.length) return;
  const lastIn = [...bubbles].reverse().find((b) => b?.direction === "in");
  if (!lastIn) return;
  let body = sanitizeForInboxDb(lastIn?.text).trim();
  const attNames = (lastIn.attachments ?? []).map((a) => a.name).filter(Boolean);
  if (attNames.length) body = body ? `${body} ${attNames.join(" ")}` : attNames.join(" ");
  if (!body) return;
  const lower = body.toLowerCase();
  for (const rule of rules) {
    if (!rule.keyword || !lower.includes(String(rule.keyword).toLowerCase())) continue;
    const { data: dup } = await sb
      .from("dm_autoreply_sent")
      .select("rule_id")
      .eq("account_id", accountId)
      .eq("conversation_id", conversationId)
      .eq("rule_id", rule.id)
      .maybeSingle();
    if (dup) break;
    let reply = (rule.reply_template ?? "").replace(/\{name\}/gi, "there");
    if (rule.use_ai && process.env.GEMINI_API_KEY) {
      reply = await generateDmReply(rule.keyword, body);
    }
    if (!reply.trim()) continue;
    const box = page.locator(".msg-form__contenteditable, div[role='textbox']").first();
    if (!(await box.isVisible({ timeout: 4000 }).catch(() => false))) break;
    await box.click({ timeout: 5000 }).catch(() => {});
    await box.fill(reply.slice(0, 4000));
    await page
      .getByRole("button", { name: /^send$|^enviar$|^enviar ahora$/i })
      .first()
      .click({ timeout: 6000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    await insertChatRowIfFresh(sb, accountId, conversationId, reply, "out", { rule_id: rule.id });
    await sb.from("dm_autoreply_sent").insert({
      account_id: accountId,
      conversation_id: conversationId,
      rule_id: rule.id,
    });
    break;
  }
}

async function insertChatRowIfFresh(
  sb: SupabaseClient,
  accountId: string,
  conversationId: string,
  messageText: string,
  direction: "in" | "out",
  extra?: { peer_name?: string | null; rule_id?: string | null; peer_photo_url?: string | null }
): Promise<boolean> {
  const trimmed = (messageText ?? "").trim();
  if (!trimmed) return false;
  const since = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const { data: existing } = await sb
    .from("messages")
    .select("id")
    .eq("account_id", accountId)
    .eq("conversation_id", conversationId)
    .eq("message_text", trimmed.slice(0, 1900))
    .eq("direction", direction)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();
  if (existing) return false;
  await sb.from("messages").insert({
    account_id: accountId,
    conversation_id: conversationId,
    message_text: trimmed.slice(0, 8000),
    direction,
    peer_name: extra?.peer_name ?? null,
    rule_id: extra?.rule_id ?? null,
    peer_photo_url: extra?.peer_photo_url ?? null,
  });
  return true;
}

function accountDailyCap(account: Record<string, unknown>, kind: LimitKind): number | undefined {
  const col =
    kind === "message"
      ? "daily_message_budget"
      : kind === "visit"
        ? "daily_visit_budget"
        : "daily_connect_budget";
  const v = account[col];
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

async function logInboundCommentEvent(
  sb: SupabaseClient,
  userId: string,
  accountId: string,
  ruleId: string,
  eventType: "comment_reply" | "dm_followup" | "skip" | "error",
  detail: Record<string, unknown> | null
): Promise<void> {
  await sb.from("inbound_comment_events").insert({
    user_id: userId,
    account_id: accountId,
    rule_id: ruleId,
    event_type: eventType,
    detail: detail ?? null,
  });
}

async function scrollMessagingConversationList(page: Page): Promise<void> {
  const scrollers = page.locator(
    ".msg-conversations-container__conversations-list, [data-view-name='message-list'], aside .scaffold-layout__list, ul.msg-conversations-container__conversations-list"
  );
  const first = scrollers.first();
  if (await first.isVisible({ timeout: 3500 }).catch(() => false)) {
    for (let s = 0; s < 7; s++) {
      await first.evaluate(`node => { node.scrollBy(0, 900); }`).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  for (let s = 0; s < 5; s++) {
    await page.mouse.wheel(0, 650).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Un paso de scroll en la lista izquierda (virtualización de LinkedIn). */
async function scrollMessagingListOneStep(page: Page): Promise<void> {
  const delta = inboxEnvInt("INBOX_LIST_SCROLL_DELTA_PX", 1020);
  const first = page
    .locator(
      ".msg-conversations-container__conversations-list, [data-view-name='message-list'], aside .scaffold-layout__list, ul.msg-conversations-container__conversations-list"
    )
    .first();
  if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
    await first.evaluate(
      (node: HTMLElement, d: number) => {
        node.scrollBy(0, d);
      },
      delta
    ).catch(() => {});
  } else {
    await page.mouse.wheel(0, Math.min(640, delta)).catch(() => {});
  }
}

/** LinkedIn virtualiza la lista: hay que desplazar hasta que exista el índice `zeroBasedIndex`. */
async function ensureConversationListHasNthRow(page: Page, sel: string, zeroBasedIndex: number): Promise<number> {
  const need = zeroBasedIndex + 1;
  const maxSteps = inboxEnvInt("INBOX_LIST_ENSURE_MAX_STEPS", 48);
  const stepPause = inboxEnvInt("INBOX_LIST_ENSURE_STEP_MS", 75);
  let n = await page.locator(sel).count().catch(() => 0);
  let stagnant = 0;
  for (let r = 0; r < maxSteps && n < need; r++) {
    await scrollMessagingListOneStep(page);
    await new Promise((res) => setTimeout(res, stepPause));
    const n2 = await page.locator(sel).count().catch(() => 0);
    if (n2 <= n) stagnant += 1;
    else stagnant = 0;
    n = n2;
    if (stagnant >= inboxEnvInt("INBOX_LIST_ENSURE_STAGNANT_MAX", 7)) break;
  }
  return n;
}

/**
 * Sube/baja la lista con scroll incremental y fusiona ids hasta que deje de crecer
 * o se alcance el tope (LinkedIn solo monta un subconjunto de filas en el DOM).
 */
async function collectInboxRowsWithScroll(page: Page, maxThreads: number): Promise<InboxListRow[]> {
  const collectCap = Math.min(2000, Math.max(maxThreads, inboxEnvInt("INBOX_LIST_COLLECT_CAP", 1200)));
  const scrollRounds = inboxEnvInt("INBOX_LIST_SCROLL_ROUNDS", 55);
  const stableNeeded = inboxEnvInt("INBOX_LIST_SCROLL_STABLE_ROUNDS", 5);
  const pauseMs = inboxEnvInt("INBOX_LIST_SCROLL_PAUSE_MS", 72);
  const burstSteps = inboxEnvInt("INBOX_LIST_SCROLL_BURST_STEPS", 2);
  const burstGapMs = inboxEnvInt("INBOX_LIST_SCROLL_BURST_GAP_MS", 28);
  const extractMax = Math.min(2500, collectCap + 200);

  await page
    .evaluate(
      `() => { var u = document.querySelector("ul.msg-conversations-container__conversations-list"); if (u) u.scrollTop = 0; }`
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_LIST_AFTER_SCROLL_TOP_MS", 160)));

  const byId = new Map<string, InboxListRow>();
  const order: string[] = [];

  const merge = (batch: InboxListRow[]): boolean => {
    if (!Array.isArray(batch)) return false;
    for (const r of batch) {
      if (byId.has(r.conversationId)) continue;
      byId.set(r.conversationId, r);
      order.push(r.conversationId);
      if (order.length >= collectCap) return true;
    }
    return false;
  };

  let stable = 0;
  for (let round = 0; round < scrollRounds; round++) {
    const batch = await extractInboxRowsFromOrderedListDom(page, extractMax);
    const before = order.length;
    if (merge(batch)) break;
    // Ya tenemos las N conversaciones que el sync va a volcar: no seguir scrolleando.
    if (order.length >= maxThreads) break;
    if (order.length === before) stable += 1;
    else stable = 0;
    if (stable >= stableNeeded) break;
    const steps = Math.max(1, burstSteps);
    for (let b = 0; b < steps; b++) {
      await scrollMessagingListOneStep(page);
      if (b < steps - 1) await new Promise((r) => setTimeout(r, burstGapMs));
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  const slice = order.slice(0, maxThreads).map((id) => byId.get(id)!);
  console.log(
    `[inbox_sync] ids únicos en lista (scroll ordenado): ${order.length}, volcando: ${slice.length} (maxThreads=${maxThreads})`
  );
  return slice;
}

/**
 * Selectores de filas de la lista de conversaciones (misma lista para contar y para clic).
 * Orden: más específicos primero. Evitar `aside ul li` (coge navegación, no chats).
 */
const CONV_ROW_SELECTORS = [
  ".msg-conversations-container__conversations-list > li",
  "ul.msg-conversations-container__conversations-list li",
  '[data-view-name="message-list-item"]',
  '[data-view-name="message-list-item-conversation"]',
  ".msg-conversation-listitem",
  'aside li[class*="conversation"]',
] as const;

/** Un solo selector activo: el primero con al menos una fila (count y clic deben coincidir). */
async function resolveConversationRowSelector(page: Page): Promise<string | null> {
  for (const sel of CONV_ROW_SELECTORS) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) {
      console.log(`[inbox_sync] lista conversaciones selector=${sel.slice(0, 50)}… filas=${n}`);
      return sel;
    }
  }
  return null;
}

async function clickConvRow(page: Page, rowSelector: string, rowIndex: number): Promise<boolean> {
  const loc = page.locator(rowSelector).nth(rowIndex);
  const ok = await loc.isVisible({ timeout: 4000 }).catch(() => false);
  if (!ok) return false;
  await loc.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await loc.click({ timeout: 14_000, force: true }).catch(async () => {
    await loc.click({ timeout: 10_000 }).catch(() => {});
  });
  return true;
}

// ─── Voyager API inbox sync ────────────────────────────────────────────────

/** Construye URL de foto desde VectorImage de LinkedIn Voyager. */
function buildVoyagerPhotoUrl(pic: unknown): string | null {
  if (!pic || typeof pic !== "object") return null;
  const p = pic as Record<string, unknown>;
  const vi =
    (p["com.linkedin.common.VectorImage"] as Record<string, unknown> | undefined) ??
    (typeof p.rootUrl === "string" ? p : null);
  if (!vi) return null;
  const root = typeof vi.rootUrl === "string" ? vi.rootUrl : null;
  const arts = vi.artifacts as Array<Record<string, unknown>> | undefined;
  if (!root || !Array.isArray(arts) || !arts.length) return null;
  const best = [...arts].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
  const seg = best?.fileIdentifyingUrlPathSegment;
  if (typeof seg !== "string" || !seg) return null;
  return root.endsWith("/") ? `${root}${seg}` : `${root}/${seg}`;
}

/** Extrae conversationId (segmento de /messaging/thread/<id>/) desde un URN de Voyager. */
function voyagerUrnToThreadId(urn: string): string | null {
  if (!urn) return null;
  // Formato tuple: urn:li:msg_conversation:(urn:li:fsd_profile:...,2-abc=) → "2-abc="
  const tupleM = urn.match(/,([^,)]+)\)$/);
  if (tupleM?.[1]) {
    try { return decodeURIComponent(tupleM[1]); } catch { return tupleM[1]; }
  }
  // Formato directo: urn:li:thread:2-abc= → "2-abc="
  const simpleM = urn.match(/urn:li:(?:thread|msg_thread):(.+)$/);
  if (simpleM?.[1]) return simpleM[1];
  return null;
}

/** Parsea MiniProfile de LinkedIn Voyager. */
function parseMiniProfileVoyager(mp: unknown): { name: string | null; photoUrl: string | null } {
  if (!mp || typeof mp !== "object") return { name: null, photoUrl: null };
  const o = mp as Record<string, unknown>;
  const fn = typeof o.firstName === "string" ? o.firstName.trim() : "";
  const ln = typeof o.lastName === "string" ? o.lastName.trim() : "";
  const name = [fn, ln].filter(Boolean).join(" ") || null;
  const photoUrl = buildVoyagerPhotoUrl(o.picture) ?? buildVoyagerPhotoUrl(o.profilePicture);
  return { name, photoUrl };
}

/**
 * Parsea respuesta de /voyager/api/messaging/conversations.
 * Maneja formato normalized (included) e inline (elements).
 */
function parseVoyagerConversationList(body: unknown, maxRows: number): InboxListRow[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;

  const candidates: unknown[] = [];
  // Formato 1: included con $type que contiene "Conversation"
  if (Array.isArray(b.included)) {
    for (const item of b.included) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (String(o.$type ?? "").toLowerCase().includes("conversation") && typeof o.entityUrn === "string") {
        candidates.push(item);
      }
    }
  }
  // Formato 2: b.elements directos
  if (!candidates.length && Array.isArray(b.elements)) {
    for (const item of b.elements) { if (item && typeof item === "object") candidates.push(item); }
  }
  // Formato 3: b.data.elements
  if (!candidates.length) {
    const data = b.data as Record<string, unknown> | undefined;
    if (data && Array.isArray(data.elements)) {
      for (const item of data.elements) { if (item && typeof item === "object") candidates.push(item); }
    }
  }

  // Índice de included por URN para resolver referencias
  const includedByUrn = new Map<string, Record<string, unknown>>();
  if (Array.isArray(b.included)) {
    for (const item of b.included) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.entityUrn === "string") includedByUrn.set(o.entityUrn, o);
      if (typeof o.$id === "string") includedByUrn.set(o.$id, o);
    }
  }

  const rows: InboxListRow[] = [];
  for (const conv of candidates) {
    if (rows.length >= maxRows) break;
    const c = conv as Record<string, unknown>;

    // conversationId desde conversationId directo o URN
    const rawUrn = String(c.entityUrn ?? "");
    let conversationId = typeof c.conversationId === "string" ? c.conversationId : voyagerUrnToThreadId(rawUrn);
    if (!conversationId && rawUrn) {
      const m = rawUrn.match(/(2-[A-Za-z0-9+/=_-]+)/);
      if (m?.[1]) conversationId = m[1];
    }
    if (!conversationId) continue;

    // Timestamp real
    const lastActivityAt = Number(c.lastActivityAt ?? c.lastSeenAt ?? 0);
    const lastActivityAtIso = lastActivityAt > 0 ? new Date(lastActivityAt).toISOString() : null;

    // Participantes → nombre y foto del peer
    let peerName: string | null = null;
    let peerPhotoUrl: string | null = null;
    const participantsRaw = c.participants;
    const participantsList: unknown[] = Array.isArray(participantsRaw)
      ? participantsRaw
      : Array.isArray((participantsRaw as Record<string, unknown> | undefined)?.elements)
        ? ((participantsRaw as Record<string, unknown>).elements as unknown[])
        : [];
    for (const p of participantsList) {
      if (!p || typeof p !== "object") continue;
      const pm = p as Record<string, unknown>;
      let mp: unknown = pm.miniProfile;
      if (!mp && typeof pm.entityUrn === "string") {
        const res = includedByUrn.get(pm.entityUrn);
        if (res) mp = res.miniProfile ?? res;
      }
      if (!mp && typeof pm.firstName === "string") mp = pm;
      const parsed = parseMiniProfileVoyager(mp);
      if (parsed.name) peerName = parsed.name;
      if (parsed.photoUrl) peerPhotoUrl = parsed.photoUrl;
      if (peerName) break;
    }

    // Preview del último evento/mensaje
    let preview = "—";
    const eventsRaw = c.events ?? c.messages;
    const eventsList: unknown[] = Array.isArray(eventsRaw)
      ? eventsRaw
      : Array.isArray((eventsRaw as Record<string, unknown> | undefined)?.elements)
        ? ((eventsRaw as Record<string, unknown>).elements as unknown[])
        : [];
    const lastEvent = eventsList.length ? eventsList[eventsList.length - 1] : null;
    if (lastEvent && typeof lastEvent === "object") {
      const ev = lastEvent as Record<string, unknown>;
      const content = ev.eventContent ?? ev.messageBody;
      if (content && typeof content === "object") {
        const bd = (content as Record<string, unknown>).attributedBody ?? (content as Record<string, unknown>).body;
        if (bd && typeof bd === "object") {
          const text = String((bd as Record<string, unknown>).text ?? "").trim();
          if (text) preview = text.slice(0, 300);
        }
      }
      if (preview === "—" && typeof ev.body === "string") preview = ev.body.slice(0, 300);
    }

    rows.push({ conversationId, peerName, preview, peerPhotoUrl, lastActivityAtIso });
  }
  return rows;
}

/** Fetch de una página de conversaciones via Voyager API (ejecutado dentro del browser context). */
async function fetchVoyagerConversationPage(
  page: Page,
  start: number,
  count: number,
  timeoutMs: number,
): Promise<unknown | null> {
  return page.evaluate(
    async ([s, c, ms]: [number, number, number]) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms);
      try {
        const jsM = document.cookie.match(/JSESSIONID=(?:"([^"]+)"|([^;\s]+))/);
        const csrf = ((jsM?.[1] ?? jsM?.[2]) || "").replace(/^"/, "").replace(/"$/, "");
        const url = `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=${s}&count=${c}`;
        const r = await fetch(url, {
          credentials: "include",
          signal: ac.signal,
          headers: {
            accept: "application/vnd.linkedin.normalized+json+2.1",
            "csrf-token": csrf,
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
        });
        if (!r.ok) return { _status: r.status };
        return await r.json();
      } catch (e) {
        return { _error: String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
    [start, count, timeoutMs] as [number, number, number]
  );
}

/**
 * Sincroniza inbox completo via Voyager API interna de LinkedIn.
 * Sin navegaciones, sin clics. Retorna null si la API no está disponible.
 */
async function runMessagingInboxSyncVoyager(
  page: Page,
  maxThreads: number,
  timeoutMs: number,
): Promise<InboxListRow[] | null> {
  const pageSize = 100;
  const maxPages = Math.ceil(maxThreads / pageSize);
  const allRows: InboxListRow[] = [];
  const seen = new Set<string>();

  for (let pg = 0; pg < maxPages; pg++) {
    const start = pg * pageSize;
    const count = Math.min(pageSize, maxThreads - allRows.length);
    const body = await fetchVoyagerConversationPage(page, start, count, Math.min(timeoutMs, 15_000));

    if (!body || typeof body !== "object") {
      if (pg === 0) return null;
      break;
    }
    const b = body as Record<string, unknown>;
    if (b._error || (typeof b._status === "number" && (b._status as number) >= 400)) {
      console.log(`[inbox_voyager] API no disponible: ${b._error ?? b._status}`);
      if (pg === 0) return null;
      break;
    }

    const rows = parseVoyagerConversationList(body, maxThreads - allRows.length);
    if (pg === 0 && rows.length === 0) {
      console.log("[inbox_voyager] página 0 sin resultados — sin acceso o inbox vacío");
      return null;
    }

    let added = 0;
    for (const r of rows) {
      if (!seen.has(r.conversationId)) {
        seen.add(r.conversationId);
        allRows.push(r);
        added++;
      }
    }
    console.log(`[inbox_voyager] página ${pg + 1}/${maxPages}: +${added} conversaciones (total=${allRows.length})`);

    if (rows.length < count || allRows.length >= maxThreads) break;
    if (pg < maxPages - 1) await new Promise((r) => setTimeout(r, 180));
  }

  return allRows.length > 0 ? allRows : null;
}

// ─── fin Voyager API inbox sync ────────────────────────────────────────────

async function runMessagingInboxSync(
  page: Page,
  sb: SupabaseClient,
  accountId: string,
  _userId: string,
  opts: { maxThreads: number }
): Promise<void> {
  // Estrategia principal: scroll + extracción ordenada desde ul.msg-conversations-container__conversations-list
  // (HTML vivo suele incluir /messaging/thread/… en outerHTML o en <a href>).
  // Fallback: clic por fila si no hay suficientes ids en DOM (umbral INBOX_SYNC_BULK_MIN_ROWS).

  // ── Estrategia 1: Voyager API (fetch interno) — sin navegaciones ni clics ──
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_PAGE_SETTLE_MS", 900)));
  await page.locator("main, .application-outlet, aside").first().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});

  const voyagerRows = await runMessagingInboxSyncVoyager(page, opts.maxThreads, 15_000);
  if (voyagerRows) {
    await bulkUpsertInboxConversationsOrdered(sb, accountId, voyagerRows, Date.now());
    console.log(`[inbox_sync] completado vía Voyager API (${voyagerRows.length} conversaciones)`);
    return;
  }
  console.log("[inbox_sync] Voyager API no disponible — usando fallback DOM");

  // ── Estrategia 2 (fallback): scroll + extracción de lista DOM ──────────────
  // Usar viewport ancho (≥1300px) para forzar el modo split-view de LinkedIn.
  await page.setViewportSize({ width: 1536, height: 864 }).catch(() => {});
  await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_AFTER_MAIN_VISIBLE_MS", 400)));

  const orderedRows = await collectInboxRowsWithScroll(page, opts.maxThreads);
  if (orderedRows.length > 0) {
    await bulkUpsertInboxConversationsOrdered(sb, accountId, orderedRows, Date.now());
  }
  const bulkMin = inboxEnvInt("INBOX_SYNC_BULK_MIN_ROWS", 4);
  if (orderedRows.length >= bulkMin) {
    console.log(`[inbox_sync] completado vía lista DOM (${orderedRows.length} conversaciones)`);
    return;
  }
  if (orderedRows.length > 0) {
    console.log(`[inbox_sync] lista DOM parcial (${orderedRows.length} < ${bulkMin}); completando con clic por fila`);
  } else {
    console.log("[inbox_sync] sin ids en lista DOM — modo clic por fila");
  }

  await page
    .evaluate(
      `() => { var u = document.querySelector("ul.msg-conversations-container__conversations-list"); if (u) u.scrollTop = 0; }`
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_LIST_RESET_MS", 320)));

  const rowSelector = await resolveConversationRowSelector(page);
  if (!rowSelector) {
    console.log("[inbox_sync] sin filas; inbox vacío o selectores desactualizados");
    return;
  }
  const totalRows = await page.locator(rowSelector).count().catch(() => 0);
  console.log(`[inbox_sync] filas en DOM (modo clic): ${totalRows}`);
  if (totalRows === 0) {
    console.log("[inbox_sync] lista vacía — abortando");
    return;
  }

  const scrollPauseMs = inboxEnvInt("INBOX_LIST_SCROLL_PAUSE_MS", 72);

  // ── Modo clic: cada fila → conversationId + nombre + foto ─────────────────
  // LinkedIn reordena la lista: la conversación recién vista sube al tope.
  // Índice de fila = conversaciones ya guardadas en este run; skipAdvance salta filas no clicables / sin id / duplicado.
  const maxTarget = opts.maxThreads;
  const seenConversationIds = new Set<string>();
  let skipAdvance = 0;
  let consecutiveFails = 0;
  let realProcessedCount = 0; // conversaciones reales (sin skips/dups) — para calcular updated_at sintético
  const syncBaseTime = Date.now(); // base para timestamps sintéticos cuando LinkedIn no expone el suyo

  while (seenConversationIds.size < maxTarget && consecutiveFails < 5) {
    // Si salimos de mensajería por error, volvemos
    if (!page.url().includes("linkedin.com/messaging") || page.url().includes("/thread/")) {
      await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 40000 });
      await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_GOTO_MESSAGING_SETTLE_MS", 620)));
    }

    const rowIndex = seenConversationIds.size + skipAdvance;
    const currentSel = (await resolveConversationRowSelector(page)) ?? rowSelector;

    // Asegurar que la fila en posición rowIndex exista en el DOM (virtualización de LinkedIn)
    let availableRows = await ensureConversationListHasNthRow(page, currentSel, rowIndex);
    if (availableRows <= rowIndex) {
      const extra = inboxEnvInt("INBOX_LIST_EXTRA_SCROLL_WHEN_STUCK", 28);
      for (let es = 0; es < extra && availableRows <= rowIndex; es++) {
        await scrollMessagingListOneStep(page);
        await new Promise((r) => setTimeout(r, scrollPauseMs));
        availableRows = await ensureConversationListHasNthRow(page, currentSel, rowIndex);
      }
    }
    if (availableRows <= rowIndex) {
      console.log(`[inbox_sync] índice ${rowIndex}: solo ${availableRows} filas disponibles — fin de lista`);
      break;
    }

    const rowLoc = page.locator(currentSel).nth(rowIndex);

    // Desplazar la fila al viewport y esperar hidratación lazy-load
    await rowLoc.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_ROW_SETTLE_MS", 220)));

    // Extraer timestamp real de LinkedIn de la fila.
    // LinkedIn puede usar <time datetime="...">, data-time (epoch ms), o solo texto relativo.
    const linkedInTimestamp = await rowLoc
      .evaluate(
        `(row) => {
          // 1. <time datetime="ISO">
          var timeEl = row.querySelector("time[datetime]");
          if (timeEl) {
            var dt = timeEl.getAttribute("datetime");
            if (dt && dt.length > 5) return dt;
          }
          // 2. data-time (epoch ms)
          var dataTimeEl = row.querySelector("[data-time]");
          if (dataTimeEl) {
            var epoch = parseInt(dataTimeEl.getAttribute("data-time") || "0", 10);
            if (epoch > 0) return new Date(epoch).toISOString();
          }
          // 3. aria-label en el time element (LinkedIn a veces usa esto)
          var timeByClass = row.querySelector(".msg-conversation-card__time-stamp, [class*='time-stamp'], [class*='timestamp']");
          if (timeByClass) {
            var dtClass = timeByClass.getAttribute("datetime") || timeByClass.getAttribute("data-time");
            if (dtClass) return dtClass;
          }
          // 4. Cualquier atributo datetime en el subtree
          var allTimes = row.querySelectorAll("[datetime]");
          if (allTimes.length > 0) {
            var dt2 = allTimes[0].getAttribute("datetime");
            if (dt2 && dt2.length > 5) return dt2;
          }
          return "";
        }`
      )
      .catch(() => "") as string;

    const rowTimeText = await rowLoc
      .evaluate(
        `(row) => {
          var tsEl = row.querySelector(
            "time.msg-conversation-card__time-stamp, time.msg-conversation-listitem__time-stamp, " +
            ".msg-conversation-card__time-stamp, .msg-conversation-listitem__time-stamp"
          );
          if (!tsEl) return "";
          return (tsEl.textContent || "").replace(/\\s+/g, " ").trim();
        }`
      )
      .catch(() => "") as string;

    const listActivityFromRow = resolveListRowActivityIso(
      { timeStampRaw: linkedInTimestamp, timeStampText: rowTimeText },
      new Date()
    );

    // Capturar foto y preview de la fila DE LISTA (antes del clic, mientras la lista está visible).
    // NOTA: LinkedIn usa lazy-load JS: img.src (propiedad) puede ser diferente de getAttribute("src")
    // (atributo HTML original). Siempre usar .src para obtener la URL actual tras la hidratación.
    const photoFromList = await rowLoc
      .evaluate(
        `(row) => {
          function getUrl(el) {
            if (!el) return "";
            // .src es la propiedad JS (refleja cambios dinámicos), no el atributo HTML original
            var u = el.getAttribute("data-delayed-url") || el.getAttribute("data-src") || el.src || "";
            if (!u || u.indexOf("data:") === 0 || u.indexOf("ghost") >= 0) return "";
            return u.indexOf("http") === 0 ? u : "";
          }
          // 1. Buscar img.presence-entity__image (el avatar circular del contacto en la lista)
          var presenceImg = row.querySelector("img.presence-entity__image, img[class*='presence-entity']");
          if (presenceImg) {
            var pu = getUrl(presenceImg);
            if (pu && pu.indexOf("licdn.com") >= 0) return pu;
          }
          // 2. Cualquier img cargada (naturalWidth > 0) con URL de CDN dentro de la fila
          var imgs = row.querySelectorAll("img");
          for (var i = 0; i < imgs.length; i++) {
            var pu2 = getUrl(imgs[i]);
            if (pu2 && pu2.indexOf("licdn.com") >= 0) return pu2;
          }
          // 3. Imágenes ya renderizadas (naturalWidth > 0)
          for (var i2 = 0; i2 < imgs.length; i2++) {
            if (imgs[i2].naturalWidth > 0) {
              var pu3 = getUrl(imgs[i2]);
              if (pu3 && pu3.indexOf("http") === 0) return pu3;
            }
          }
          // 4. picture > source[srcset]
          var sources = row.querySelectorAll("picture > source");
          for (var si = 0; si < sources.length; si++) {
            var ss = (sources[si].getAttribute("srcset") || sources[si].getAttribute("data-srcset") || "").split(",")[0];
            var su = ss.trim().split(" ")[0];
            if (su && su.indexOf("http") === 0) return su;
          }
          return "";
        }`
      )
      .catch(() => "") as string;
    const listPreview = await extractRowPreviewText(rowLoc);

    // Clic en la fila
    const clickOk = await rowLoc
      .click({ timeout: 12_000, force: true })
      .then(() => true)
      .catch(() => false);

    if (!clickOk) {
      console.log(`[inbox_sync] índice ${rowIndex}: no se pudo clicar — probando siguiente`);
      consecutiveFails++;
      skipAdvance++;
      continue;
    }
    consecutiveFails = 0;

    // Esperar a que la SPA navegue al hilo (pushState — suele ser instantáneo)
    await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_AFTER_NAV_MS", 260)));

    const currentUrl = page.url();
    const m = currentUrl.match(/\/messaging\/thread\/([^/?#]+)/i);
    const conversationId = m?.[1] ? decodeURIComponent(m[1]) : "";

    if (!conversationId) {
      console.log(`[inbox_sync] índice ${rowIndex}: URL sin threadId (${currentUrl.slice(-40)})`);
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(async () => {
        await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
      });
      await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_GOBACK_SETTLE_MS", 280)));
      skipAdvance++;
      continue;
    }

    if (seenConversationIds.has(conversationId)) {
      // Debería ser raro con la estrategia de índice = conversaciones ya guardadas, pero por si acaso
      console.log(`[inbox_sync] índice ${rowIndex}: ${conversationId.slice(0, 14)}… duplicado`);
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(async () => {
        await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
      });
      await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_GOBACK_SETTLE_MS", 280)));
      skipAdvance++;
      continue;
    }

    // Esperar a que se cargue el panel del hilo antes de extraer nombre
    await page
      .locator(".msg-entity-lockup, .msg-thread__top-bar, [class*='thread-detail'], [class*='msg-s-message']")
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_PANEL_EXTRA_MS", 300)));

    const peerName = (await extractPeerNameFromMessagingThread(page))?.trim() || null;

    // Foto: 1) de la fila de lista (antes del clic), 2) del panel DERECHO del hilo (no de toda la página)
    let peerPhotoUrl: string | null = photoFromList && photoFromList.length > 4 ? photoFromList : null;
    if (!peerPhotoUrl) {
      // Llamar a extractPeerPhotoUrlFromThread que ya usa IIFE y apunta al panel correcto
      peerPhotoUrl = await extractPeerPhotoUrlFromThread(page);
    }

    // Si LinkedIn no expone timestamp, usar tiempo sintético decreciente:
    // índice 0 (más reciente) → mayor timestamp; índice N → menor timestamp.
    const effectiveTs = linkedInTimestamp || new Date(syncBaseTime - realProcessedCount * 120_000).toISOString();
    seenConversationIds.add(conversationId);
    skipAdvance = 0;
    realProcessedCount++;
    // list_rank 0 = primera fila clicada (más reciente en LinkedIn en ese momento); desempate en API junto a last_at
    await upsertInboxConversationOne(sb, accountId, {
      conversation_id: conversationId,
      peer_name: peerName,
      peer_photo_url: peerPhotoUrl,
      list_preview: listPreview,
      linkedin_updated_at: effectiveTs,
      list_rank: realProcessedCount - 1,
      list_last_activity_at: listActivityFromRow ?? null,
    });
    console.log(
      `[inbox_sync] ✓ ${realProcessedCount}/${maxTarget}: ${peerName ?? conversationId.slice(0, 12)} foto=${!!peerPhotoUrl} ts=${listActivityFromRow ? listActivityFromRow.slice(0, 16) : linkedInTimestamp ? linkedInTimestamp.slice(0, 16) : "synth"}`
    );

    // Volver a la lista con goBack() — la SPA de LinkedIn preserva el estado
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(async () => {
      console.log("[inbox_sync] goBack falló, navegando a /messaging/ directamente");
      await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_GOTO_MESSAGING_FALLBACK_MS", 520)));
    });
    await new Promise((r) => setTimeout(r, inboxEnvInt("INBOX_CLICK_GOBACK_SETTLE_MS", 280)));
  }

  console.log(`[inbox_sync] terminado: ${seenConversationIds.size} conversaciones en inbox_conversations`);
}

/** Extrae solo el texto del snippet de preview de una fila de la lista (sin nombre ni timestamp). */
async function extractRowPreviewText(rowLoc: import("playwright").Locator): Promise<string> {
  // Intentar selector específico del snippet de LinkedIn
  const snippetSels = [
    ".msg-conversation-card__message-snippet",
    "[class*='message-snippet']",
    "[class*='preview']",
    "[class*='snippet']",
    "p[class*='subline']",
  ];
  for (const s of snippetSels) {
    const el = rowLoc.locator(s).first();
    if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
      const t = normalizeMsgText(String((await el.innerText().catch(() => "")) ?? ""));
      if (t.length >= 2) return t.slice(0, 300);
    }
  }
  // Fallback: innerText completo de la fila, acortado
  const full = normalizeMsgText(String((await rowLoc.innerText().catch(() => "")) ?? ""));
  return full.slice(0, 300) || "—";
}

/** Tareas en `running` si el worker murió nunca vuelven a `pending` sin esto. */
async function recoverStaleRunningTasks(sb: SupabaseClient): Promise<void> {
  const mins = Number(process.env.TASK_STALE_RUNNING_MINUTES ?? 45);
  const payload = {
    status: "pending" as const,
    error_message: "requeued_stale_running",
    locked_at: null as null,
  };

  const pollStaleSec = Number(process.env.TASK_STALE_POLL_RUNNING_SEC ?? 120);
  if (Number.isFinite(pollStaleSec) && pollStaleSec >= 30) {
    const pollIso = new Date(Date.now() - pollStaleSec * 1000).toISOString();
    // Solo poll_comments y poll_messages tienen timeout corto (120s).
    // sync_inbox y sync_inbox_thread son de larga duración — usan el timeout de 45 min.
    const shortStaleActions = ["poll_comments", "poll_messages", "verify_session", "session_check"];
    const { data: pa, error: pe1 } = await sb
      .from("tasks")
      .update({ ...payload, error_message: "requeued_stale_poll" as const })
      .eq("status", "running")
      .in("action", shortStaleActions)
      .not("locked_at", "is", null)
      .lt("locked_at", pollIso)
      .select("id");
    const { data: pb, error: pe2 } = await sb
      .from("tasks")
      .update({ ...payload, error_message: "requeued_stale_poll" as const })
      .eq("status", "running")
      .in("action", shortStaleActions)
      .is("locked_at", null)
      .lt("created_at", pollIso)
      .select("id");

    if (colMissingLockedAt(pe1?.message) && colMissingLockedAt(pe2?.message)) {
      /* sin columna locked_at */
    } else {
      if (pe1 && !colMissingLockedAt(pe1.message)) console.error("[tasks] recover stale poll:", pe1.message);
      if (pe2 && !colMissingLockedAt(pe2.message)) console.error("[tasks] recover stale poll (legacy):", pe2.message);
      const pn = (pa?.length ?? 0) + (pb?.length ?? 0);
      if (pn > 0) {
        console.log(
          `[tasks] Reencoladas ${pn} tarea(s) poll en «running» >${pollStaleSec}s — el worker puede seguir con campañas.`
        );
      }
    }
  }

  if (!Number.isFinite(mins) || mins < 5) return;

  const staleIso = new Date(Date.now() - mins * 60 * 1000).toISOString();

  const { data: a, error: e1 } = await sb
    .from("tasks")
    .update(payload)
    .eq("status", "running")
    .not("locked_at", "is", null)
    .lt("locked_at", staleIso)
    .select("id");

  const { data: b, error: e2 } = await sb
    .from("tasks")
    .update(payload)
    .eq("status", "running")
    .is("locked_at", null)
    .lt("created_at", staleIso)
    .select("id");

  if (colMissingLockedAt(e1?.message) && colMissingLockedAt(e2?.message)) {
    return;
  }
  if (e1 && !colMissingLockedAt(e1.message)) console.error("[tasks] recover stale (locked_at):", e1.message);
  if (e2 && !colMissingLockedAt(e2.message)) console.error("[tasks] recover stale (legacy):", e2.message);

  const n = (a?.length ?? 0) + (b?.length ?? 0);
  if (n > 0) {
    console.log(`[tasks] Reencoladas ${n} tarea(s) que estaban en «running» demasiado tiempo (≥${mins} min).`);
  }
}

async function claimTask(sb: SupabaseClient, taskId: string) {
  const now = new Date().toISOString();
  const { data: cur } = await sb.from("tasks").select("attempts").eq("id", taskId).single();
  const attempts = (cur?.attempts ?? 0) + 1;
  let { data, error } = await sb
    .from("tasks")
    .update({ status: "running", attempts, locked_at: now })
    .eq("id", taskId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error?.message?.includes("locked_at") || error?.message?.includes("schema cache")) {
    ({ data, error } = await sb
      .from("tasks")
      .update({ status: "running", attempts })
      .eq("id", taskId)
      .eq("status", "pending")
      .select("*")
      .maybeSingle());
  }
  if (error || !data) return null;
  return data;
}

/**
 * Comprueba cap diario + cap horario para un tipo de acción.
 * Si alguno está agotado, devuelve { ok: false, rescheduleMs: <próximo momento válido> }.
 * "Próximo momento válido" = medianoche si es diario, inicio de siguiente hora si es horario.
 */
async function checkCaps(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind,
  capOverride: number | undefined,
  taskAttempts: number
): Promise<{ ok: true } | { ok: false; rescheduleMs: number; reason: "daily" | "hourly" }> {
  const [daily, hourly] = await Promise.all([
    checkUnderDailyCap(redis, accountId, kind, capOverride),
    checkUnderHourlyCap(redis, accountId, kind),
  ]);
  if (!daily.ok) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(6 + Math.floor(Math.random() * 2), Math.floor(Math.random() * 30), 0, 0);
    return { ok: false, rescheduleMs: tomorrow.getTime(), reason: "daily" };
  }
  if (!hourly.ok) {
    // Reprogramar al inicio de la siguiente hora + jitter de hasta 20 min
    const nextHour = new Date();
    nextHour.setUTCHours(nextHour.getUTCHours() + 1, Math.floor(Math.random() * 20), 0, 0);
    return { ok: false, rescheduleMs: nextHour.getTime(), reason: "hourly" };
  }
  return { ok: true };
}

/**
 * Incrementa contadores diario y horario para un tipo de acción.
 */
async function incrementCaps(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind,
  capOverride: number | undefined
): Promise<void> {
  await Promise.all([
    incrementDailyCount(redis, accountId, kind, capOverride),
    incrementHourlyCount(redis, accountId, kind),
  ]);
}

/**
 * Persiste el reschedule cuando un cap está agotado y retorna.
 */
async function applyCapReschedule(
  sb: SupabaseClient,
  redis: RedisClient,
  taskId: string,
  taskAttempts: number,
  rescheduleMs: number,
  reason: string
): Promise<void> {
  await sb.from("tasks").update({
    status: "pending",
    scheduled_at: new Date(rescheduleMs).toISOString(),
    attempts: Math.max(0, taskAttempts - 1),
    error_message: `cap_${reason}`,
  }).eq("id", taskId);
  await enqueueTaskDue(redis, taskId, rescheduleMs);
}

async function failTask(
  sb: SupabaseClient,
  redis: RedisClient,
  task: Record<string, unknown>,
  msg: string,
  page?: import("playwright").Page | null
) {
  const attempts = (task.attempts as number) ?? 1;
  const taskId = task.id as string;
  const scheduledAt = task.scheduled_at as string;
  const finalMsg = page ? await enrichWorkerFailureMessage(msg, taskId, page) : msg.slice(0, 500);

  if (attempts >= MAX_ATTEMPTS) {
    await sb.from("tasks").update({ status: "dead", error_message: finalMsg }).eq("id", taskId);
    await removeTaskFromDue(redis, taskId);
    void dispatchTaskWebhook(sb, taskId, "task.failed");
    const action = task.action as string;
    const accId = task.account_id as string | undefined;
    if (accId && (action === "verify_session" || action === "session_check")) {
      await sb.from("linkedin_accounts").update({ connection_status: "error" }).eq("id", accId);
    }
    // Marcar el enrollment como fallido para que no quede huérfano sin tarea pendiente
    const enrollmentId = task.enrollment_id as string | undefined;
    if (enrollmentId) {
      await failEnrollmentAfterDeadTask(sb, enrollmentId);
    }
    return;
  }

  const backoff = Math.min(3600_000, 60_000 * 2 ** (attempts - 1));
  const next = new Date(Date.now() + backoff).toISOString();
  await sb
    .from("tasks")
    .update({ status: "pending", error_message: finalMsg, scheduled_at: next })
    .eq("id", taskId);

  await enqueueTaskDue(redis, taskId, new Date(next).getTime());
}

async function completeTask(sb: SupabaseClient, redis: RedisClient, taskId: string) {
  await sb.from("tasks").update({ status: "completed", error_message: null }).eq("id", taskId);
  await removeTaskFromDue(redis, taskId);
  void dispatchTaskWebhook(sb, taskId, "task.completed");
}

async function pauseAccountSoftban(sb: SupabaseClient, accountId: string) {
  const until = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  await sb
    .from("linkedin_accounts")
    .update({ softban_status: "paused", paused_until: until })
    .eq("id", accountId);
}

function proxyServer(row: { host: string; port: number }): string {
  return `http://${row.host}:${row.port}`;
}

/**
 * Devuelve true si la hora UTC actual está dentro del horario de trabajo configurado.
 * Variables de entorno: AUTOMATION_WORK_HOURS_START (default 7) y AUTOMATION_WORK_HOURS_END (default 21).
 * La comprobación es en UTC; ajusta con AUTOMATION_WORK_HOURS_UTC_OFFSET si el equipo está en otra zona.
 */
function isWithinWorkingHours(): boolean {
  // Solo activo si el usuario define explícitamente AUTOMATION_WORK_HOURS_START en el .env.
  // Sin esa variable, siempre devuelve true (sin restricción de horario).
  const startEnv = process.env.AUTOMATION_WORK_HOURS_START;
  const endEnv   = process.env.AUTOMATION_WORK_HOURS_END;
  if (!startEnv || !endEnv) return true; // opt-in: sin configurar = sin límite horario
  const startH = parseInt(startEnv, 10);
  const endH   = parseInt(endEnv,   10);
  const offsetH = parseFloat(process.env.AUTOMATION_WORK_HOURS_UTC_OFFSET ?? "0");
  if (!Number.isFinite(startH) || !Number.isFinite(endH)) return true;
  const nowH = (new Date().getUTCHours() + offsetH + 24) % 24;
  return nowH >= startH && nowH < endH;
}

/** Acciones de automatización que consumen cuota LinkedIn y requieren cooldown. */
const LINKEDIN_AUTOMATION_ACTIONS = new Set([
  "visit_profile",
  "connect",
  "follow",
  "send_message",
  "send_message_open_profile",
  "voice_note",
  "reply_comment",
  "inmail",
  "like_post",
  "comment_post",
]);

export async function runOneTask(sb: SupabaseClient, redis: RedisClient, taskId: string): Promise<void> {
  const task = await claimTask(sb, taskId);
  if (!task) return;
  await removeTaskFromDue(redis, taskId).catch(() => {});

  const action = task.action as string;
  console.log("[worker] Ejecutando tarea", taskId.slice(0, 8) + "…", "action=", action);

  // Acciones que no requieren navegador ni cuenta activa — resuelven inmediatamente.
  if (action === "wait" || action === "sync_lead_photo" || action === "batch_sync_lead_photos") {
    try {
      await completeTask(sb, redis, taskId);
      const enrollmentId = task.enrollment_id as string | undefined;
      if (enrollmentId) {
        await advanceEnrollmentAfterStep(sb, redis, enrollmentId);
      }
    } catch (e) {
      console.error(`[worker] ${action}(${taskId.slice(0, 8)}) advance failed:`, e instanceof Error ? e.message : e);
    }
    return;
  }

  const accountId = task.account_id as string;
  const payload = (task.payload ?? {}) as Record<string, unknown>;

  const { data: account, error: acErr } = await sb
    .from("linkedin_accounts")
    .select("*")
    .eq("id", accountId)
    .single();

  if (acErr || !account) {
    await failTask(sb, redis, task, "account_not_found");
    return;
  }

  if (account.paused_until && new Date(account.paused_until) > new Date()) {
    const next = new Date(account.paused_until).getTime() + 60_000;
    await sb
      .from("tasks")
      .update({
        status: "pending",
        scheduled_at: new Date(next).toISOString(),
        attempts: Math.max(0, (task.attempts as number) - 1),
      })
      .eq("id", taskId);

    await enqueueTaskDue(redis, taskId, next);
    return;
  }

  // ── Guardia 1: horario laboral ────────────────────────────────────────────
  // Las tareas de automatización LinkedIn solo corren dentro del horario configurado
  // (por defecto 07:00-21:00 UTC). Fuera de ese rango, reprogramar para el inicio
  // del siguiente bloque horario para no desperdiciar intentos.
  if (LINKEDIN_AUTOMATION_ACTIONS.has(action) && !isWithinWorkingHours()) {
    const startH = parseInt(process.env.AUTOMATION_WORK_HOURS_START ?? "7", 10);
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + (next.getUTCHours() >= startH ? 1 : 0));
    next.setUTCHours(startH, Math.floor(Math.random() * 20), 0, 0); // pequeño jitter de minutos
    const nextMs = next.getTime();
    await sb.from("tasks").update({
      status: "pending",
      scheduled_at: new Date(nextMs).toISOString(),
      attempts: Math.max(0, (task.attempts as number) - 1),
      error_message: "outside_work_hours",
    }).eq("id", taskId);
    await enqueueTaskDue(redis, taskId, nextMs);
    console.log(`[worker] Tarea ${taskId.slice(0, 8)} (${action}) fuera de horario — reprogramada para ${new Date(nextMs).toISOString()}`);
    return;
  }

  // ── Guardia 2: cooldown entre acciones por cuenta ─────────────────────────
  // Simula el tiempo mínimo que un humano tarda entre acciones LinkedIn.
  // Evita ráfagas de actividad que disparan detección de bots.
  if (LINKEDIN_AUTOMATION_ACTIONS.has(action)) {
    const cooldownSec = await getAccountCooldownSec(redis, accountId);
    if (cooldownSec > 0) {
      const nextMs = Date.now() + (cooldownSec + 15) * 1000;
      await sb.from("tasks").update({
        status: "pending",
        scheduled_at: new Date(nextMs).toISOString(),
        attempts: Math.max(0, (task.attempts as number) - 1),
        error_message: "account_cooldown",
      }).eq("id", taskId);
      await enqueueTaskDue(redis, taskId, nextMs);
      return;
    }
  }

  let liAt: string;
  try {
    liAt = decryptSecret(account.li_at_cookie);
  } catch {
    await failTask(sb, redis, task, "decrypt_cookie_failed");
    return;
  }

  // acquireBrowserSlot fuera del try/finally: si Redis falla aquí el slot no se corrompe
  // (nunca se incrementó), pero la tarea quedaría "running". Por eso capturamos el error
  // y tratamos una excepción igual que gotSlot=false: reprogramar sin gastar un intento.
  let gotSlot = false;
  try {
    gotSlot = await acquireBrowserSlot(redis);
  } catch (slotErr) {
    console.error(`[worker] acquireBrowserSlot error (${taskId.slice(0, 8)}):`, slotErr instanceof Error ? slotErr.message : slotErr);
  }
  if (!gotSlot) {
    // Esperar más tiempo si es tarea de campaña para no ciclar cada 15s
    const isEnrollment = !!(task.enrollment_id as string | undefined);
    const waitMs = isEnrollment ? 60_000 : 15_000; // campaña: 1 min; resto: 15s
    const reschedAt = new Date(Date.now() + waitMs).toISOString();
    await sb
      .from("tasks")
      .update({
        status: "pending",
        scheduled_at: reschedAt,
        attempts: Math.max(0, (task.attempts as number) - 1),
        error_message: "no_browser_slot",
      })
      .eq("id", taskId)
      .then(undefined, (e: unknown) => console.error("[worker] reschedule no-slot:", e));
    await enqueueTaskDue(redis, taskId, Date.now() + waitMs).catch(() => {});
    return;
  }

  let browser: Awaited<ReturnType<typeof createContext>> | null = null;
  let traceCtl: TraceController | null = null;

  try {
    let proxyId = account.proxy_id as string | null;
    let proxyRow = proxyId ? await loadProxy(sb, proxyId) : null;

    if (!proxyRow) {
      // Intenta asignar un proxy libre del pool del usuario
      const newPid = await pickProxyForAccount(sb, account.user_id as string, accountId, proxyId).catch(() => null);
      if (newPid) {
        proxyId = newPid;
        proxyRow = await loadProxy(sb, newPid);
      }
    }

    const proxy =
      proxyRow && proxyRow.host
        ? {
            server: proxyServer(proxyRow),
            username: proxyRow.username ?? undefined,
            password: proxyRow.password ?? undefined,
          }
        : undefined;

    // Safety gate: si REQUIRE_PROXY=true nunca lanzamos sin proxy para no exponer la IP del VPS
    if (!proxy && process.env.REQUIRE_PROXY === "true") {
      const reschedAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await sb.from("tasks").update({ status: "pending", scheduled_at: reschedAt, error_message: "no_proxy_available", attempts: Math.max(0, (task.attempts as number) - 1) }).eq("id", taskId);
      await enqueueTaskDue(redis, taskId, Date.now() + 5 * 60_000).catch(() => {});
      console.warn(`[worker] Tarea ${taskId.slice(0, 8)} sin proxy — reprogramada en 5 min (REQUIRE_PROXY=true)`);
      return;
    }

    const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
    console.log("[worker] Abriendo navegador (headless=", headless, proxy ? `proxy=${proxyRow?.host}` : "SIN PROXY ⚠️", ") para", action);
    browser = await createContext({ proxy, headless });
    const { page } = browser;
    await injectLiAt(page, liAt);

    if (proxyId) await markProxyUsed(sb, proxyId);

    traceCtl = await startPlaywrightTraceIfConfigured(browser.context, taskId, action);
    const fail = async (m: string) => {
      if (traceCtl) {
        await traceCtl.stopSaveFailure();
        traceCtl = null;
      }
      await failTask(sb, redis, task, m, page);
    };

    const enrollmentId = task.enrollment_id as string | undefined;

    const profileAutomationActions = new Set([
      "visit_profile",
      "follow",
      "connect",
      "send_message",
      "send_message_open_profile",
      "voice_note",
      "reply_comment",
      "inmail",
      "like_post",
      "comment_post",
    ]);
    if (profileAutomationActions.has(action)) {
      const ses = await ensureLinkedInFeedSession(page);
      if (ses.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!ses.ok) {
        await fail(ses.error ?? "linkedin_session_failed");
        return;
      }
    }

    const messagingSessionActions = new Set([
      "poll_messages",
      "poll_comments",
      "reply_dm",
      "sync_inbox",
      "sync_inbox_thread",
    ]);
    if (messagingSessionActions.has(action)) {
      const ses = await ensureLinkedInFeedSession(page);
      if (ses.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!ses.ok) {
        await fail(ses.error ?? "linkedin_session_failed");
        return;
      }
    }

    const afterSuccess = async () => {
      await completeTask(sb, redis, taskId);
      // Cooldown post-acción: impide que la siguiente tarea de esta cuenta arranque
      // inmediatamente — simula el tiempo humano entre acciones LinkedIn.
      if (LINKEDIN_AUTOMATION_ACTIONS.has(action)) {
        await setAccountCooldown(redis, accountId).catch(() => {});
      }
      if (enrollmentId) {
        try {
          await advanceEnrollmentAfterStep(sb, redis, enrollmentId);
        } catch (advErr) {
          // No propagamos — la tarea ya está completada; el enrollment se recuperará en el siguiente ciclo
          console.error(`[worker] advanceEnrollmentAfterStep(${enrollmentId.slice(0, 8)}) falló:`, advErr instanceof Error ? advErr.message : advErr);
        }
      }
    };

    if (action === "verify_session" || action === "session_check") {
      /** `openFeed` hace scroll ~30s y no comprueba /login; en verificación usamos sesión rápida y URL. */
      const r = await ensureLinkedInFeedSession(page);
      const verifiedAt = new Date().toISOString();
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await sb
          .from("linkedin_accounts")
          .update({
            connection_status: "error",
            session_verified_at: verifiedAt,
            li_display_name: null,
            li_headline: null,
            li_photo_url: null,
          })
          .eq("id", accountId);
        await afterSuccess();
        return;
      }

      let profile: { displayName: string | null; headline: string | null; photoUrl: string | null } = {
        displayName: null,
        headline: null,
        photoUrl: null,
      };
      const profileScrapeMs = 50_000;
      try {
        profile = await Promise.race([
          scrapeLoggedInMemberProfile(page),
          new Promise<typeof profile>((_, reject) =>
            setTimeout(() => reject(new Error("scrapeLoggedInMemberProfile_timeout")), profileScrapeMs)
          ),
        ]);
      } catch (e) {
        console.error("scrapeLoggedInMemberProfile", e);
      }

      await sb
        .from("linkedin_accounts")
        .update({
          connection_status: "active",
          session_verified_at: verifiedAt,
          li_display_name: profile.displayName,
          li_headline: profile.headline,
          li_photo_url: profile.photoUrl,
        })
        .eq("id", accountId);
      await afterSuccess();
      return;
    }

    if (action === "sync_profile") {
      const verifiedAt = new Date().toISOString();
      let profile: { displayName: string | null; headline: string | null; photoUrl: string | null } = {
        displayName: null,
        headline: null,
        photoUrl: null,
      };
      try {
        profile = await scrapeLoggedInMemberProfile(page);
      } catch (e) {
        console.error("sync_profile scrape", e);
      }
      await sb
        .from("linkedin_accounts")
        .update({
          li_display_name: profile.displayName,
          li_headline: profile.headline,
          li_photo_url: profile.photoUrl,
          session_verified_at: verifiedAt,
        })
        .eq("id", accountId);
      await afterSuccess();
      return;
    }

    if (action === "sync_linkedin_posts") {
      const ses = await ensureLinkedInFeedSession(page);
      if (ses.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!ses.ok) {
        await fail(ses.error ?? "linkedin_session_failed");
        return;
      }
      let scraped: ScrapeActivityPostsResult["posts"] = [];
      let activityPid: string | null = null;
      try {
        const r = await scrapeLoggedInMemberActivityPosts(page, 80);
        scraped = r.posts ?? [];
        activityPid = r.publicIdentifier;
      } catch (e) {
        console.error("[sync_linkedin_posts] scrape", e);
      }
      for (const row of scraped) {
        const url = row.linkedin_activity_url;
        if (!url || !row.content.trim()) continue;
        const content = row.content.slice(0, 19000);
        const { data: existing } = await sb
          .from("posts")
          .select("id")
          .eq("account_id", accountId)
          .eq("linkedin_activity_url", url)
          .maybeSingle();
        if (existing?.id) {
          await sb
            .from("posts")
            .update({
              content,
              linkedin_activity_urn: row.linkedin_activity_urn ?? null,
              status: "published",
            })
            .eq("id", existing.id);
        } else {
          const { error: insErr } = await sb.from("posts").insert({
            account_id: accountId,
            content,
            status: "published",
            linkedin_activity_url: url,
            linkedin_activity_urn: row.linkedin_activity_urn ?? null,
            image_url: null,
          });
          if (insErr) console.error("[sync_linkedin_posts] insert", insErr.message);
        }
      }
      const pidLog = activityPid ?? "?";
      console.log(
        `[sync_linkedin_posts] account=${accountId.slice(0, 8)}… pid=${pidLog} items=${scraped.length}`
      );
      await afterSuccess();
      return;
    }

    if (action === "warmup_feed") {
      const url = payload.random_profile_url as string | undefined;
      const r = await sessionWarmup(page, url);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "warmup_feed_failed");
        return;
      }
      await sb.from("linkedin_accounts").update({ last_warmup_at: new Date().toISOString() }).eq("id", accountId);
      await afterSuccess();
      return;
    }

    if (action === "visit_profile") {
      const capCheck = await checkCaps(redis, accountId, "visit", accountDailyCap(account, "visit"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const r = await visitProfile(page, profileUrl, { light: true });
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "visit_failed");
        return;
      }
      await persistLeadProfilePhotoFromOpenPage(sb, page, {
        leadId: task.lead_id as string | null | undefined,
        accountUserId: account.user_id as string,
        profileUrl,
      });
      await incrementCaps(redis, accountId, "visit", accountDailyCap(account, "visit"));
      await afterSuccess();
      return;
    }

    if (action === "sync_lead_photo") {
      // Tarea obsoleta: la foto principal ya no se consulta visitando el perfil uno por uno 
      // para no interrumpir el flujo del worker con ventanas aleatorias de perfiles.
      await afterSuccess();
      return;
    }

    if (action === "batch_sync_lead_photos") {
      // Tarea obsoleta: la foto principal ya se obtiene vía harvestapi/linkedin-profile-search.
      // Se omite visitar el perfil para no agotar el cupo ni generar loops infinitos pendientes.
      await afterSuccess();
      return;
    }

    if (action === "follow") {
      const capCheck = await checkCaps(redis, accountId, "connect", accountDailyCap(account, "connect"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const r = await followProfile(page, profileUrl);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "follow_failed");
        return;
      }
      await incrementCaps(redis, accountId, "connect", accountDailyCap(account, "connect"));
      await afterSuccess();
      return;
    }

    if (action === "like_post") {
      const capCheck = await checkCaps(redis, accountId, "visit", accountDailyCap(account, "visit"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const r = await likeLeadRecentPost(page, profileUrl);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "like_failed");
        return;
      }
      await incrementCaps(redis, accountId, "visit", accountDailyCap(account, "visit"));
      await afterSuccess();
      return;
    }

    if (action === "comment_post") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const tmpl = (payload.message_template as string | undefined) ?? "";
      let commentText = tmpl
        .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
        .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
        .trim();
      if (!commentText) {
        commentText = process.env.GEMINI_API_KEY
          ? await generateDmReply(
              String(payload.lead_name ?? "post"),
              `Comment on post by ${payload.lead_name ?? ""} from ${payload.lead_company ?? ""}`
            )
          : "👍 Great post!";
      }
      const r = await commentLeadRecentPost(page, profileUrl, commentText.slice(0, 3000));
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "comment_failed");
        return;
      }
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await afterSuccess();
      return;
    }

    if (action === "connect") {
      const capCheck = await checkCaps(redis, accountId, "connect", accountDailyCap(account, "connect"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      let note = payload.note as string | undefined;
      const tmpl = payload.message_template as string | undefined;
      if (tmpl && tmpl.includes("{")) {
        note = tmpl
          .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
          .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
          .slice(0, 300);
      } else if (!note && process.env.GEMINI_API_KEY) {
        note = await generateConnectionMessage({
          name: payload.lead_name as string,
          company: payload.lead_company as string,
          title: payload.lead_title as string,
        });
      }
      const r = await sendConnectionRequest(page, profileUrl, note);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "connect_failed");
        return;
      }
      await incrementCaps(redis, accountId, "connect", accountDailyCap(account, "connect"));
      await afterSuccess();
      return;
    }

    if (action === "send_message") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      let text =
        (payload.message_template as string | undefined)?.replace(/\{name\}/gi, String(payload.lead_name ?? "")) ??
        "Hi, thanks for connecting.";
      if (process.env.GEMINI_API_KEY && text.length < 20) {
        text = await generateConnectionMessage({
          name: payload.lead_name as string,
          company: payload.lead_company as string,
          title: payload.lead_title as string,
          objective: "follow-up after connect",
        });
      }
      const r = await sendMessageToProfile(page, profileUrl, text);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "message_failed");
        return;
      }
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await afterSuccess();
      return;
    }

    if (action === "send_message_open_profile") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      let text =
        (payload.message_template as string | undefined)?.replace(/\{name\}/gi, String(payload.lead_name ?? "")) ??
        "Hi, thanks for connecting.";
      if (process.env.GEMINI_API_KEY && text.length < 20) {
        text = await generateConnectionMessage({
          name: payload.lead_name as string,
          company: payload.lead_company as string,
          title: payload.lead_title as string,
          objective: "follow-up after connect",
        });
      }
      const r = await sendMessageToOpenProfile(page, profileUrl, text);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "message_failed");
        return;
      }
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await afterSuccess();
      return;
    }

    if (action === "voice_note") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const tmpl = String(payload.message_template ?? "");
      const b64match = tmpl.trim().match(/^data:[^;]+;base64,([\s\S]+)$/i);
      if (b64match) {
        let est: number;
        try {
          est = Buffer.byteLength(b64match[1]!.replace(/\s/g, ""), "base64");
        } catch {
          await fail("voice_note_invalid_data_url");
          return;
        }
        if (est > 5 * 1024 * 1024) {
          await fail("voice_note_payload_too_large");
          return;
        }
      }
      const tmpPath = await writeVoiceDataUrlToTempFile(String(taskId), tmpl);
      if (!tmpPath) {
        await fail("voice_note_invalid_data_url");
        return;
      }
      try {
        const r = await sendVoiceNoteToProfile(page, profileUrl, tmpPath);
        if (r.softban) {
          await pauseAccountSoftban(sb, accountId);
          await fail("softban");
          return;
        }
        if (!r.ok) {
          await fail(r.error ?? "voice_note_failed");
          return;
        }
        await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
        await afterSuccess();
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
      return;
    }

    if (action === "reply_comment") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const tmpl = (payload.message_template as string | undefined) ?? "";
      let text = tmpl
        .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
        .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
        .trim();
      if (!text) {
        text = process.env.GEMINI_API_KEY
          ? await generateDmReply(
              String(payload.lead_name ?? "comment"),
              `Reply to comment by ${payload.lead_name ?? ""} from ${payload.lead_company ?? ""}`
            )
          : "Thanks for your comment!";
      }
      const r = await replyToCommentOnLeadRecentPost(page, profileUrl, text.slice(0, 3000));
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "reply_comment_failed");
        return;
      }
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await afterSuccess();
      return;
    }

    if (action === "inmail") {
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const profileUrl = String(payload.profile_url ?? "");
      const raw = String(payload.message_template ?? "");
      const parts = raw.split(/\n---\n/);
      let subject = parts.length >= 2 ? parts[0]!.trim() : "Hello";
      let body =
        parts.length >= 2
          ? parts
              .slice(1)
              .join("\n---\n")
              .trim()
              .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
              .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
          : raw.replace(/\{name\}/gi, String(payload.lead_name ?? "")).replace(/\{company\}/gi, String(payload.lead_company ?? ""));
      if (parts.length < 2 && process.env.GEMINI_API_KEY) {
        body = await generateConnectionMessage({
          name: payload.lead_name as string,
          company: payload.lead_company as string,
          title: payload.lead_title as string,
          objective: "professional InMail body",
        });
      }
      if (!body.trim()) {
        await fail("inmail_empty_body");
        return;
      }
      const r = await sendInMailToProfile(page, profileUrl, subject.slice(0, 200), body.slice(0, 8000));
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "inmail_failed");
        return;
      }
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await afterSuccess();
      return;
    }

    if (action === "publish_post") {
      const postId = payload.post_id as string;
      const { data: post } = await sb.from("posts").select("*").eq("id", postId).single();
      if (!post) {
        await fail("post_not_found");
        return;
      }
      let imagePath: string | undefined;
      if (post.image_url?.startsWith("data:")) {
        const tmp = path.join(os.tmpdir(), `li-${postId}.png`);
        const b64 = post.image_url.split(",")[1];
        if (b64) {
          await fs.writeFile(tmp, Buffer.from(b64, "base64"));
          imagePath = tmp;
        }
      } else if (post.image_url?.startsWith("http")) {
        try {
          const imgRes = await fetch(post.image_url);
          if (imgRes.ok) {
            const ext = post.image_url.includes(".png") ? "png" : "jpg";
            const tmp = path.join(os.tmpdir(), `li-${postId}.${ext}`);
            await fs.writeFile(tmp, Buffer.from(await imgRes.arrayBuffer()));
            imagePath = tmp;
          }
        } catch { /* sin imagen */ }
      }
      const r = await publishPost(page, post.content, imagePath);
      if (imagePath) await fs.unlink(imagePath).catch(() => {});
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      let linkedin_activity_url: string | null = null;
      let linkedin_activity_urn: string | null = null;
      if (r.ok) {
        try {
          const u = page.url();
          linkedin_activity_url = u.split("?")[0].slice(0, 2000);
          const m = u.match(/(urn:li:[^/?#\s]+)/);
          linkedin_activity_urn = m?.[1] ?? null;
        } catch {
          /* ignore */
        }
      }
      await sb
        .from("posts")
        .update({
          status: r.ok ? "published" : "failed",
          ...(r.ok
            ? { linkedin_activity_url: linkedin_activity_url ?? null, linkedin_activity_urn }
            : {}),
        })
        .eq("id", postId);
      await afterSuccess();
      return;
    }

    if (action === "poll_messages") {
      const maxThreads = inboxPollMessagesMaxThreads();
      const pollMs = inboxPollMessagesPollMs(maxThreads);
      try {
        await runPollWithTimeout(async () => {
          await runMessagingInboxSync(page, sb, accountId, account.user_id as string, { maxThreads });
          await completeTask(sb, redis, taskId);
        }, pollMs, "poll_messages");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
      return;
    }

    if (action === "sync_inbox") {
      const maxThreads = inboxSyncMaxThreads();
      const pollMs = inboxSyncPollMs(maxThreads);
      try {
        await runPollWithTimeout(async () => {
          await runMessagingInboxSync(page, sb, accountId, account.user_id as string, { maxThreads });
          await completeTask(sb, redis, taskId);
        }, pollMs, "sync_inbox");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
      return;
    }

    if (action === "sync_inbox_thread") {
      const conversationId = String(payload.conversation_id ?? "").trim();
      if (!conversationId) {
        await fail("sync_inbox_thread_missing_conversation_id");
        return;
      }
      const keywordsAutoReply = Boolean(payload.keywords_auto_reply);
      const pollMs = inboxThreadSyncPollMs();
      try {
        await runPollWithTimeout(async () => {
          await runMessagingThreadSync(page, sb, accountId, account.user_id as string, conversationId, {
            keywordsAutoReply,
          });
          await completeTask(sb, redis, taskId);
        }, pollMs, "sync_inbox_thread");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
      return;
    }

    if (action === "poll_comments") {
      const pollMs = Number(process.env.POLL_TASK_TIMEOUT_MS ?? 90_000);
      const userId = account.user_id as string;
      try {
        await runPollWithTimeout(async () => {
          await page.goto("https://www.linkedin.com/notifications/", { waitUntil: "domcontentloaded", timeout: 60000 });
          await new Promise((r) => setTimeout(r, 1200));
          const { data: rules } = await sb
            .from("keyword_rules")
            .select("*")
            .eq("user_id", userId)
            .eq("rule_type", "comment")
            .eq("is_active", true);
          let list = rules ?? [];
          list = list.filter((r) => !r.account_id || r.account_id === accountId);
          if (!list.length) {
            await completeTask(sb, redis, taskId);
            return;
          }
          const postIds = [...new Set(list.map((r) => r.post_id).filter(Boolean))] as string[];
          const postMap = new Map<
            string,
            { id: string; account_id: string; linkedin_activity_urn: string | null; linkedin_activity_url: string | null }
          >();
          if (postIds.length) {
            const { data: postsRows } = await sb
              .from("posts")
              .select("id, account_id, linkedin_activity_urn, linkedin_activity_url")
              .in("id", postIds);
            for (const p of postsRows ?? []) {
              if (p.account_id === accountId) postMap.set(p.id, p);
            }
          }

          function postMatches(
            rule: (typeof list)[0],
            notificationText: string,
            linkHref: string
          ): boolean {
            if (!rule.post_id) return true;
            const p = postMap.get(rule.post_id);
            if (!p) return false;
            if (p.linkedin_activity_urn) {
              const short = p.linkedin_activity_urn.replace(/^urn:li:/, "");
              return (
                notificationText.includes(p.linkedin_activity_urn) ||
                notificationText.includes(short)
              );
            }
            if (p.linkedin_activity_url) {
              try {
                const path = new URL(p.linkedin_activity_url).pathname;
                const last = path.split("/").filter(Boolean).pop() ?? "";
                return last.length > 6 && (notificationText.includes(last) || linkHref.includes(last));
              } catch {
                return notificationText.includes(p.linkedin_activity_url.slice(0, 80));
              }
            }
            return true;
          }

          const raw = await page
            .locator("main")
            .innerText()
            .catch(() => page.locator("body").innerText().catch(() => ""));
          const lower = raw.toLowerCase();
          const matchedByKw = list.filter(
            (rule) => rule.keyword && lower.includes(String(rule.keyword).toLowerCase())
          );
          if (!matchedByKw.length) {
            await completeTask(sb, redis, taskId);
            return;
          }

          const links = page.locator('main a[href*="/feed/update/"], main a[href*="activity"]');
          const n = await links.count();
          let replied = false;
          for (let i = 0; i < Math.min(n, 25); i++) {
            const aEl = links.nth(i);
            const href = (await aEl.getAttribute("href")) ?? "";
            const label = (
              (await aEl.innerText().catch(() => "")) +
              (await aEl.getAttribute("aria-label").catch(() => ""))
            ).toLowerCase();
            const rule = matchedByKw.find(
              (r) =>
                r.keyword &&
                label.includes(String(r.keyword).toLowerCase()) &&
                postMatches(r, raw, href)
            );
            if (!rule) continue;

            // Dedup: evitar responder dos veces al mismo post en el mismo día
            const hrefUrnMatch = href.match(/feed\/update\/([^/?#]+)/i);
            const tentativeConvId = hrefUrnMatch?.[1] ? `feed:${hrefUrnMatch[1].slice(0, 120)}` : null;
            if (tentativeConvId) {
              const { data: existingMsg } = await sb
                .from("messages")
                .select("id")
                .eq("account_id", accountId)
                .eq("conversation_id", tentativeConvId)
                .maybeSingle();
              if (existingMsg) continue;
            }

            await aEl.click({ timeout: 8000 }).catch(() => {});
            await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 1800));

            let reply = (rule.reply_template ?? "").replace(/\{name\}/gi, "there");
            if (rule.use_ai && process.env.GEMINI_API_KEY) {
              const ctx = await page.locator("main").innerText().catch(() => "");
              reply = await generateDmReply(String(rule.keyword), ctx.slice(0, 4000));
            }
            if (!reply.trim()) continue;

            // Activar el composer de comentarios si hay un trigger visible (placeholder)
            const commentTriggerSel = [
              '[data-placeholder*="comment" i]',
              '[data-placeholder*="comentario" i]',
              '[aria-placeholder*="comment" i]',
              '[aria-placeholder*="comentario" i]',
              '[placeholder*="comment" i]',
            ].join(", ");
            const triggerEl = page.locator(commentTriggerSel).first();
            if (await triggerEl.isVisible({ timeout: 3000 }).catch(() => false)) {
              await triggerEl.click({ timeout: 5000 }).catch(() => {});
              await new Promise((r) => setTimeout(r, 700));
            }

            // Buscar el cuadro de texto (múltiples selectores para UI minificada de LinkedIn)
            const boxSel = [
              '[contenteditable][aria-label*="comment" i]',
              '[contenteditable][aria-placeholder*="comment" i]',
              '[contenteditable][aria-placeholder*="comentario" i]',
              '[contenteditable][data-placeholder*="comment" i]',
              '[contenteditable][data-placeholder*="comentario" i]',
              '.comments-comment-box__form-container [contenteditable]',
              '.comments-comment-texteditor [contenteditable]',
              'div[role="textbox"]',
            ].join(", ");
            const box = page.locator(boxSel).first();
            if (!(await box.isVisible({ timeout: 10000 }).catch(() => false))) {
              await logInboundCommentEvent(sb, userId, accountId, rule.id, "error", {
                step: "comment_box",
                error: "comment_box_not_found",
                post_url: page.url(),
              });
              continue;
            }
            await box.click({ timeout: 5000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 400));
            await box.fill(reply.slice(0, 3000));
            await new Promise((r) => setTimeout(r, 600));

            // Enviar el comentario — probamos varios selectores antes del fallback por role
            const submitSelectors = [
              'button[type="submit"]',
              'button[aria-label*="Post comment" i]',
              'button[aria-label*="Publicar comentario" i]',
              'button[aria-label*="Publicar" i]',
              '.comments-comment-box__submit-button',
            ];
            let commentSubmitted = false;
            for (const sel of submitSelectors) {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await btn.click({ timeout: 6000 }).catch(() => {});
                commentSubmitted = true;
                break;
              }
            }
            if (!commentSubmitted) {
              await page
                .getByRole("button", { name: /^post$|^publicar$|post comment|publicar comentario/i })
                .first()
                .click({ timeout: 6000 })
                .catch(() => {});
            }
            await new Promise((r) => setTimeout(r, 2500));
            const postUrl = page.url();
            const um = postUrl.match(/feed\/update\/([^/?#]+)/i) ?? postUrl.match(/ugcPost[^?#]+/i);
            const convId = um?.[1] ? `feed:${um[1].slice(0, 120)}` : `comment:${rule.id}:${Date.now()}`;
            await insertChatRowIfFresh(sb, accountId, convId, reply.slice(0, 800), "out", { rule_id: rule.id });
            await logInboundCommentEvent(sb, userId, accountId, rule.id, "comment_reply", {
              post_url: postUrl,
              keyword: rule.keyword,
            });

            const dmTpl = String(rule.dm_followup_template ?? "").trim();
            const wantsDm = dmTpl.length > 0 || Boolean(rule.dm_followup_use_ai);
            if (wantsDm) {
              if (!dmTpl && !process.env.GEMINI_API_KEY) {
                await logInboundCommentEvent(sb, userId, accountId, rule.id, "skip", {
                  reason: "dm_followup_needs_template_or_gemini",
                });
              } else {
                const msgCap = await checkUnderDailyCap(
                  redis,
                  accountId,
                  "message",
                  accountDailyCap(account, "message")
                );
                if (!msgCap.ok) {
                  await logInboundCommentEvent(sb, userId, accountId, rule.id, "skip", { reason: "message_cap" });
                } else {
                  let dmText = dmTpl.replace(/\{name\}/gi, "there");
                  if (rule.dm_followup_use_ai && process.env.GEMINI_API_KEY) {
                    const ctx = await page.locator("main").innerText().catch(() => "");
                    dmText = await generateDmReply(String(rule.keyword), ctx.slice(0, 4000));
                  }
                  if (!dmText.trim()) {
                    await logInboundCommentEvent(sb, userId, accountId, rule.id, "skip", { reason: "dm_empty" });
                  } else {
                    try {
                      const hrefs = await page
                        .locator('main a[href*="/in/"]')
                        .evaluateAll((els) =>
                          els
                            .map((e) => (e as HTMLAnchorElement).getAttribute("href") || "")
                            .filter((h) => h && !h.includes("/in/me") && !h.includes("/in/learning"))
                        );
                      let profileUrl: string | null = null;
                      for (const h of hrefs) {
                        const abs = h.startsWith("http")
                          ? h
                          : `https://www.linkedin.com${h.startsWith("/") ? "" : "/"}${h}`;
                        if (/linkedin\.com\/in\/[^/?#]+/i.test(abs)) {
                          profileUrl = abs.split("?")[0];
                          break;
                        }
                      }
                      if (!profileUrl) {
                        await logInboundCommentEvent(sb, userId, accountId, rule.id, "skip", {
                          reason: "no_profile_link",
                        });
                      } else {
                        const rDm = await sendMessageToProfile(page, profileUrl, dmText.slice(0, 8000));
                        if (rDm.ok) {
                          await incrementCaps(
                            redis,
                            accountId,
                            "message",
                            accountDailyCap(account, "message")
                          );
                          const dmConv = `inbound-dm:${rule.id}:${Date.now()}`;
                          await insertChatRowIfFresh(sb, accountId, dmConv, dmText.slice(0, 800), "out", {
                            rule_id: rule.id,
                          });
                          await logInboundCommentEvent(sb, userId, accountId, rule.id, "dm_followup", {
                            profile_url: profileUrl,
                          });
                        } else {
                          await logInboundCommentEvent(sb, userId, accountId, rule.id, "error", {
                            step: "dm",
                            error: rDm.error ?? "failed",
                          });
                        }
                      }
                    } catch (e) {
                      await logInboundCommentEvent(sb, userId, accountId, rule.id, "error", {
                        step: "dm",
                        error: e instanceof Error ? e.message : String(e),
                      });
                    }
                  }
                }
              }
            }

            replied = true;
            break;
          }
          if (!replied) {
            await completeTask(sb, redis, taskId);
            return;
          }
          await completeTask(sb, redis, taskId);
        }, pollMs, "poll_comments");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
      return;
    }

    if (action === "import_leads") {
      const jobId = String(payload.job_id ?? "").trim();
      if (!jobId) {
        await fail("import_leads_missing_job_id");
        return;
      }
      const { data: job, error: jobErr } = await sb.from("lead_import_jobs").select("*").eq("id", jobId).maybeSingle();
      if (jobErr || !job) {
        await fail("import_job_not_found");
        return;
      }
      const jobUserId = job.user_id as string;
      if (jobUserId !== (account.user_id as string)) {
        await fail("import_job_wrong_user");
        return;
      }
      await sb.from("lead_import_jobs").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", jobId);

      const finishFail = async (msg: string) => {
        await sb.from("lead_import_jobs").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", jobId);
        await fail(msg);
      };

      const sourceTypeEarly = String(job.source_type ?? "");
      const jobPayloadEarly = (job.payload ?? {}) as Record<string, unknown>;

      if (sourceTypeEarly === "lead_finder") {
        const token = (process.env.APIFY_TOKEN ?? "").trim();
        if (!token) {
          await finishFail("Falta APIFY_TOKEN en el servidor (.env del backend)");
          return;
        }
        const { DEFAULT_LEAD_ACTOR_ID } = await import("../services/apifyLeadFinder.js");
        const { executeApifyLeadImport, isApifyImportInFlightError } = await import("../services/apifyLeadImportRun.js");
        const actorRaw = String(
          jobPayloadEarly.apify_actor_id ?? process.env.APIFY_LEAD_ACTOR ?? DEFAULT_LEAD_ACTOR_ID
        ).trim();
        const actorId = actorRaw.replace(/\//g, "~");

        let apifyInput = jobPayloadEarly.apify_input;
        if (typeof apifyInput === "string") {
          try {
            apifyInput = JSON.parse(apifyInput) as Record<string, unknown>;
          } catch {
            await finishFail("payload.apify_input no es JSON válido");
            return;
          }
        }
        if (!apifyInput || typeof apifyInput !== "object" || Array.isArray(apifyInput)) {
          await finishFail(
            "lead_finder requiere payload.apify_input (objeto JSON). Exporta los filtros desde el Lead Viewer de Pipeline Labs o la consola de Apify."
          );
          return;
        }

        const maxWaitMs = Math.min(
          Math.max(
            60_000,
            Number(jobPayloadEarly.apify_max_wait_ms) ||
              Number(process.env.APIFY_LEAD_MAX_WAIT_MS) ||
              45 * 60 * 1000
          ),
          6 * 60 * 60 * 1000
        );
        const insertCap = Math.min(
          50_000,
          Math.max(
            1,
            Number(jobPayloadEarly.max_insert) ||
              Number(process.env.APIFY_LEAD_INSERT_CAP) ||
              2000
          )
        );

        let result: Awaited<ReturnType<typeof executeApifyLeadImport>>;
        try {
          result = await executeApifyLeadImport({
            sb,
            userId: jobUserId,
            campaignId: (job.campaign_id as string | null) ?? null,
            apifyToken: token,
            actorId,
            apifyInput: apifyInput as Record<string, unknown>,
            maxWaitMs,
            insertCap,
          });
        } catch (e) {
          if (isApifyImportInFlightError(e)) {
            await sb.from("lead_import_jobs").update({ updated_at: new Date().toISOString() }).eq("id", jobId);
            await sb
              .from("tasks")
              .update({
                status: "pending",
                scheduled_at: new Date(Date.now() + 20_000).toISOString(),
                attempts: Math.max(0, (task.attempts as number) - 1),
              })
              .eq("id", taskId);
          
            await enqueueTaskDue(redis, taskId, Date.now() + 20_000);
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          await finishFail(msg);
          return;
        }

        await sb
          .from("lead_import_jobs")
          .update({
            status: "completed",
            inserted_count: result.newLeads,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
        await completeTask(sb, redis, taskId);
        return;
      }

      const ses = await ensureLinkedInFeedSession(page);
      if (ses.softban) {
        await pauseAccountSoftban(sb, accountId);
        await sb.from("lead_import_jobs").update({ status: "failed", error: "softban", updated_at: new Date().toISOString() }).eq("id", jobId);
        await fail("softban");
        return;
      }
      if (!ses.ok) {
        await finishFail(ses.error ?? "linkedin_session_failed");
        return;
      }

      const sourceType = String(job.source_type ?? "");
      const jobPayload = (job.payload ?? {}) as Record<string, unknown>;
      let profileUrls: string[] = [];

      const normalizeProfileUrl = (u: string): string | null => {
        try {
          const x = new URL(u);
          if (!x.hostname.replace(/^www\./, "").includes("linkedin.com")) return null;
          if (!x.pathname.includes("/in/")) return null;
          const path = x.pathname.replace(/\/$/, "");
          return `${x.origin}${path}`;
        } catch {
          return null;
        }
      };

      if (sourceType === "my_list") {
        const ids = jobPayload.lead_ids as string[] | undefined;
        const campaignId = job.campaign_id as string | null;
        if (!ids?.length || !campaignId) {
          await finishFail("my_list requiere lead_ids y campaign_id");
          return;
        }
        let enrolled = 0;
        const nextRun = new Date().toISOString();
        for (const lead_id of ids.slice(0, 2000)) {
          const { data: lead } = await sb.from("leads").select("id").eq("id", lead_id).eq("user_id", jobUserId).maybeSingle();
          if (!lead) continue;
          const { error: enErr } = await sb.from("campaign_enrollments").insert({
            campaign_id: campaignId,
            lead_id,
            current_step_index: 0,
            next_run_at: nextRun,
            status: "paused",
            crm_status: "not_contacted",
          });
          if (!enErr) enrolled++;
        }
        await sb
          .from("lead_import_jobs")
          .update({ status: "completed", inserted_count: enrolled, updated_at: new Date().toISOString() })
          .eq("id", jobId);
        await completeTask(sb, redis, taskId);
        return;
      }

      if (sourceType === "csv") {
        const urls = jobPayload.urls as string[] | undefined;
        const rows = jobPayload.rows as { profile_url?: string }[] | undefined;
        if (urls?.length) profileUrls = urls.map((u) => normalizeProfileUrl(u)).filter(Boolean) as string[];
        else if (rows?.length)
          profileUrls = [...new Set(rows.map((r) => normalizeProfileUrl(String(r.profile_url ?? ""))).filter(Boolean) as string[])];
      } else {
        const url = String(jobPayload.url ?? "").trim();
        if (!url) {
          await finishFail("Falta url en payload");
          return;
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await new Promise((r) => setTimeout(r, 2500));
        const hrefs = await page.$$eval('a[href*="/in/"]', (as) =>
          [...new Set(as.map((a) => (a as HTMLAnchorElement).href.split("?")[0]))]
        );
        profileUrls = [...new Set(hrefs.map((h) => normalizeProfileUrl(h)).filter(Boolean) as string[])].slice(0, 500);
      }

      if (!profileUrls.length) {
        await finishFail("No se encontraron perfiles");
        return;
      }

      const campaignId = job.campaign_id as string | null;
      let newLeads = 0;
      const nextRun = new Date().toISOString();
      for (const profile_url of profileUrls) {
        const { data: existing } = await sb
          .from("leads")
          .select("id")
          .eq("user_id", jobUserId)
          .eq("profile_url", profile_url)
          .maybeSingle();
        let leadId = existing?.id as string | undefined;
        if (!leadId) {
          const { data: leadRow, error: insLead } = await sb
            .from("leads")
            .insert({ profile_url, user_id: jobUserId })
            .select("id")
            .single();
          if (insLead || !leadRow) continue;
          leadId = leadRow.id as string;
          newLeads++;
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
      await sb
        .from("lead_import_jobs")
        .update({ status: "completed", inserted_count: newLeads, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      await completeTask(sb, redis, taskId);
      return;
    }

    if (action === "reply_dm") {
      const threadRef = String(payload.thread_url ?? payload.conversation_id ?? "").trim();
      const text = String(payload.text ?? payload.message_template ?? "").trim().slice(0, 8000);
      if (!threadRef || !text) {
        await fail("reply_dm_missing_payload");
        return;
      }
      const { conversationId } = normalizeMessagingThreadInput(threadRef);
      const capCheck = await checkCaps(redis, accountId, "message", accountDailyCap(account, "message"), task.attempts as number);
      if (!capCheck.ok) { await applyCapReschedule(sb, redis, taskId, task.attempts as number, capCheck.rescheduleMs, capCheck.reason); return; }
      const r = await sendMessageInMessagingThread(page, threadRef, text);
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "reply_dm_failed");
        return;
      }
      await insertChatRowIfFresh(sb, accountId, conversationId || threadRef, text, "out");
      await incrementCaps(redis, accountId, "message", accountDailyCap(account, "message"));
      await completeTask(sb, redis, taskId);
      return;
    }

    await fail(`unknown_action:${action}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout") || msg.includes("net::") || msg.includes("Proxy")) {
      if (account.proxy_id) await markProxyDegraded(sb, account.proxy_id as string);
    }
    if (traceCtl) {
      await traceCtl.stopSaveFailure().catch(() => {});
      traceCtl = null;
    }
    try {
      await failTask(sb, redis, task, msg.slice(0, 500), browser?.page ?? null);
    } catch (failErr) {
      // failTask puede fallar si la DB está caída; no propagamos para que el finally siempre libere el slot
      console.error(`[worker] failTask(${taskId.slice(0, 8)}) threw:`, failErr instanceof Error ? failErr.message : failErr);
    }
  } finally {
    if (browser) {
      if (traceCtl) {
        await traceCtl.stopDiscard();
        traceCtl = null;
      }
      await closeSession(browser.browser);
    }
    await releaseBrowserSlot(redis);
  }
}

export async function processDueTasks(sb: SupabaseClient, redis: RedisClient): Promise<void> {
  await recoverStaleRunningTasks(sb);

  const zids = await popDueTaskIds(redis, Date.now(), 10);
  const nowIso = new Date().toISOString();
  const { data: dueRows } = await sb
    .from("tasks")
    .select("id, action, enrollment_id, scheduled_at")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(32);

  const dbIds = dueRows?.map((r) => r.id) ?? [];
  const unique = [...new Set([...zids, ...dbIds])];

  let metaList: { id: string; action: string; enrollment_id: string | null; scheduled_at: string }[] = [];
  if (unique.length) {
    const { data: metaRows } = await sb
      .from("tasks")
      .select("id, action, enrollment_id, scheduled_at")
      .in("id", unique)
      .eq("status", "pending");
    metaList = (metaRows ?? []) as typeof metaList;
  }
  metaList.sort((a, b) => {
    const ga = taskDispatchGroup(a.action, a.enrollment_id);
    const gb = taskDispatchGroup(b.action, b.enrollment_id);
    if (ga !== gb) return ga - gb;
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });
  const orderedIds: string[] = metaList.map((r) => r.id);
  for (const id of unique) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }

  const parallelRaw = Number(process.env.WORKER_MAX_PARALLEL ?? MAX_BROWSERS);
  const maxParallel = Math.min(
    MAX_BROWSERS,
    Math.max(1, Number.isFinite(parallelRaw) && parallelRaw > 0 ? Math.floor(parallelRaw) : 1)
  );

  const metaById = new Map(metaList.map((m) => [m.id, m.action]));
  let importLeadsInBatch = 0;
  const batch: string[] = [];
  for (const id of orderedIds) {
    const action = metaById.get(id);
    if (action === "import_leads") {
      if (importLeadsInBatch >= 1) continue;
      importLeadsInBatch++;
    }
    batch.push(id);
    if (batch.length >= maxParallel) break;
  }

  if (process.env.WORKER_DEBUG === "1" || process.env.WORKER_DEBUG === "true") {
    const { count: pendAll } = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "pending");
    const { count: runAll } = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "running");
    console.log(
      "[worker:debug] poll",
      JSON.stringify({
        zset_ids: zids.length,
        db_due_ids: dbIds.length,
        merged_unique: unique.length,
        parallel: maxParallel,
        will_run: batch.length,
        tasks_pending_total: pendAll ?? 0,
        tasks_running_total: runAll ?? 0,
        next_actions: batch.map((id) => metaList.find((m) => m.id === id)?.action ?? id.slice(0, 8)),
      })
    );
  }

  if (batch.length) {
    await Promise.all(
      batch.map((taskId) =>
        runOneTask(sb, redis, taskId).catch((e: unknown) => {
          // Aísla el fallo de una tarea para que no cancele las demás del batch
          console.error(`[worker] runOneTask(${taskId.slice(0, 8)}) uncaught:`, e instanceof Error ? e.message : e);
        })
      )
    );
  }
}
