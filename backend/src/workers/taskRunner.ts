import {
  closeSession,
  createContext,
  injectLiAt,
  openFeed,
  ensureLinkedInFeedSession,
  publishPost,
  scrapeLoggedInMemberProfile,
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
} from "@linkedin-saas/automation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_BROWSERS,
  acquireBrowserSlot,
  checkUnderDailyCap,
  incrementDailyCount,
  popDueTaskIds,
  releaseBrowserSlot,
  removeTaskFromDue,
} from "../queues/redisClient.js";
import type { RedisClient } from "../queues/redisClient.js";
import { decryptSecret } from "../lib/crypto.js";
import { advanceEnrollmentAfterStep } from "../services/campaignEngine.js";
import { generateConnectionMessage, generateDmReply, generateImageBytes } from "../services/gemini.js";
import { loadProxy, markProxyDegraded, markProxyUsed, pickProxyForAccount } from "../services/proxyAssign.js";
import { enrichWorkerFailureMessage, startPlaywrightTraceIfConfigured, type TraceController } from "./linkedinRunContext.js";

const MAX_ATTEMPTS = 5;

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
    if (action === "poll_messages" || action === "poll_comments" || action === "sync_inbox") return 10;
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

/** Hilos a abrir por sync_inbox (tras recolectar ids en la lista). */
function inboxSyncMaxThreads(): number {
  return inboxEnvInt("INBOX_SYNC_MAX_THREADS", 60);
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
  const perThread = inboxEnvInt("INBOX_SYNC_MS_PER_THREAD", 4200);
  return Math.max(360_000, 95_000 + maxThreads * perThread);
}

function inboxPollMessagesPollMs(maxThreads: number): number {
  const base = Number(process.env.POLL_TASK_TIMEOUT_MS ?? 130_000);
  const perThread = inboxEnvInt("INBOX_SYNC_MS_PER_THREAD", 4200);
  return Math.max(Number.isFinite(base) ? base : 130_000, 110_000 + maxThreads * perThread);
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
    const id = await scoped
      .evaluate((root) => {
        const walk = root.parentElement ?? root;
        const html = (walk.closest("main") ?? walk).innerHTML;
        const m = html.match(/\/messaging\/thread\/([^"'\\s&?#%<>]+)/i);
        return m?.[1] ? decodeURIComponent(m[1]) : "";
      })
      .catch(() => "");
    if (id) return id;
  }
  return page
    .evaluate(() => {
      const main = document.querySelector("main");
      const html = main?.innerHTML ?? document.body.innerHTML;
      const m = html.match(/\/messaging\/thread\/([^"'\\s&?#%<>]+)/i);
      return m?.[1] ? decodeURIComponent(m[1]) : "";
    })
    .catch(() => null);
}

type InboxListRow = { conversationId: string; peerName: string | null; preview: string };

/** Una sola pasada por el DOM: regex de thread en cada fila (LinkedIn no siempre usa <a visible>). */
async function extractInboxRowsFromListDom(page: Page, max: number): Promise<InboxListRow[]> {
  return page.evaluate((maxN) => {
    const out: InboxListRow[] = [];
    const seen = new Set<string>();
    const rowEls: Element[] = [];
    for (const sel of [
      '[data-view-name="message-list-item"]',
      ".msg-conversation-listitem",
      ".msg-conversations-container__conversations-list > li",
      "ul.msg-conversations-container__conversations-list li",
    ]) {
      document.querySelectorAll(sel).forEach((el) => {
        if (rowEls.includes(el)) return;
        if (el.closest(".msg-s-message-list-container")) return;
        rowEls.push(el);
      });
    }
    for (const row of rowEls) {
      if (out.length >= maxN) break;
      const html = row.outerHTML;
      let conversationId = "";
      const m = html.match(/\/messaging\/thread\/([^"'\\s&?#%<>]+)/i);
      if (m?.[1]) conversationId = decodeURIComponent(m[1]);
      if (!conversationId) {
        const a = row.querySelector("a[href*='/messaging/thread/']") as HTMLAnchorElement | null;
        if (a?.href) {
          const m2 = a.href.match(/\/messaging\/thread\/([^/?#]+)/i);
          if (m2?.[1]) conversationId = decodeURIComponent(m2[1]);
        }
      }
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);
      const nameEl =
        row.querySelector(".msg-conversation-listitem__participant-names") ||
        row.querySelector("[class*='participant-names']") ||
        row.querySelector("h3, .truncate");
      const peerName = nameEl?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
      const preview = (row.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 700);
      out.push({
        conversationId,
        peerName,
        preview: preview || "—",
      });
    }
    return out;
  }, max);
}

async function extractPeerNameFromMessagingThread(page: Page): Promise<string | null> {
  const loc = page.locator(
    '[data-test-id="conversation-header-name"], .msg-thread__link-to-profile, h2.msg-title-bar__title-bar-title, .msg-entity-lockup__entity-title'
  );
  const t = await loc.first().innerText().catch(() => "");
  const line = t.trim().split(/\n/)[0]?.trim();
  return line || null;
}

function normalizeMsgText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function scrollThreadMessageListToBottom(page: Page): Promise<void> {
  const list = page
    .locator(
      ".msg-s-message-list-container, ul.msg-s-message-list, .msg-s-message-list, [class*='msg-s-message-list']"
    )
    .first();
  if (await list.isVisible({ timeout: 5000 }).catch(() => false)) {
    await list
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      })
      .catch(() => {});
  }
  await page.keyboard.press("End").catch(() => {});
  await new Promise((r) => setTimeout(r, 450));
}

function textLooksLikeNameOnly(text: string, peerHint: string | null | undefined): boolean {
  const t = normalizeMsgText(text);
  if (!t) return true;
  const p = normalizeMsgText(peerHint ?? "");
  if (!p) return false;
  if (t === p) return true;
  if (t.startsWith(p) && t.length <= p.length + 24) {
    const rest = normalizeMsgText(t.slice(p.length));
    if (!rest || /^[·•\d:,\/\s\-–]+$/.test(rest)) return true;
  }
  return false;
}

async function readEventItemMessageText(item: ReturnType<Page["locator"]>): Promise<string> {
  const bodyLocators = [
    "[class*='msg-s-event-listitem__message-body']",
    "[class*='message-body']",
    ".msg-s-message-group__message",
    "p.msg-s-message-group__text",
    ".msg-s-message-group__text",
    "[class*='msg-s-message-group__text']",
  ];
  for (const sel of bodyLocators) {
    const body = item.locator(sel).first();
    const raw = (await body.innerText().catch(() => "")) ?? "";
    const t = normalizeMsgText(raw);
    if (t.length > 0) return t;
  }
  return normalizeMsgText((await item.innerText().catch(() => "")) ?? "");
}

async function eventItemFromSelf(item: ReturnType<Page["locator"]>): Promise<boolean> {
  if (
    (await item.locator(".msg-s-message-group--my-message, [class*='message-from-me'], [class*='from-me']").count()) > 0
  )
    return true;
  return item
    .evaluate((el) => /from-myself|from-me|my-message|msg-s-message-group--my-message/i.test(el.className))
    .catch(() => false);
}

async function readLastMessageRow(
  page: Page,
  peerNameHint?: string | null
): Promise<{ text: string; direction: "in" | "out" } | null> {
  await scrollThreadMessageListToBottom(page);
  const items = page.locator(
    ".msg-s-event-listitem, .msg-s-message-list__event, li.msg-s-message-list__event, li[class*='msg-s-message-list'], [class*='msg-s-event-listitem']"
  );
  const n = await items.count();
  if (n < 1) return null;

  const tryIndex = async (idx: number): Promise<{ text: string; direction: "in" | "out" } | null> => {
    const item = items.nth(idx);
    const text = await readEventItemMessageText(item);
    if (!text) return null;
    const fromSelf = await eventItemFromSelf(item);
    return { text: text.slice(0, 4000), direction: fromSelf ? "out" : "in" };
  };

  const maxBack = Math.min(6, n);
  for (let back = 1; back <= maxBack; back++) {
    const row = await tryIndex(n - back);
    if (!row) continue;
    if (textLooksLikeNameOnly(row.text, peerNameHint)) continue;
    return row;
  }

  return tryIndex(n - 1);
}

async function insertChatRowIfFresh(
  sb: SupabaseClient,
  accountId: string,
  conversationId: string,
  messageText: string,
  direction: "in" | "out",
  extra?: { peer_name?: string | null; rule_id?: string | null }
) {
  const trimmed = messageText.trim();
  if (!trimmed) return;
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
  if (existing) return;
  await sb.from("messages").insert({
    account_id: accountId,
    conversation_id: conversationId,
    message_text: trimmed.slice(0, 8000),
    direction,
    peer_name: extra?.peer_name ?? null,
    rule_id: extra?.rule_id ?? null,
  });
}

type DmRuleRow = { id: string; keyword: string; reply_template: string; use_ai: boolean };

/** Enlaces visibles tras hidratar la lista (mejor que un solo evaluate al inicio). */
async function collectMessagingThreadUrlsFromAnchors(page: Page, max: number): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const anchors = page.locator('a[href*="/messaging/thread/"]');
  const n = await anchors.count();
  for (let i = 0; i < n && out.length < max; i++) {
    let href = (await anchors.nth(i).getAttribute("href"))?.trim() ?? "";
    if (!href) continue;
    if (href.startsWith("/")) href = `https://www.linkedin.com${href}`;
    href = (href.split("?")[0] ?? href).split("#")[0] ?? href;
    const m = href.match(/^(https?:\/\/[^/]+\/messaging\/thread\/[^/?#]+)/i);
    if (!m?.[1]) continue;
    const idm = m[1].match(/\/messaging\/thread\/([^/?#]+)/i);
    if (!idm?.[1]) continue;
    const id = decodeURIComponent(idm[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    const base = m[1];
    out.push(base.endsWith("/") ? base : `${base}/`);
  }
  return out;
}

async function scrollMessagingConversationList(page: Page): Promise<void> {
  const scrollers = page.locator(
    ".msg-conversations-container__conversations-list, [data-view-name='message-list'], aside .scaffold-layout__list, ul.msg-conversations-container__conversations-list"
  );
  const first = scrollers.first();
  if (await first.isVisible({ timeout: 3500 }).catch(() => false)) {
    for (let s = 0; s < 7; s++) {
      await first.evaluate((node) => node.scrollBy(0, 900)).catch(() => {});
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
  const first = page
    .locator(
      ".msg-conversations-container__conversations-list, [data-view-name='message-list'], aside .scaffold-layout__list, ul.msg-conversations-container__conversations-list"
    )
    .first();
  if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
    await first.evaluate((node) => node.scrollBy(0, 720)).catch(() => {});
  } else {
    await page.mouse.wheel(0, 520).catch(() => {});
  }
}

/**
 * Sube/baja la lista con scroll incremental y fusiona ids hasta que deje de crecer
 * o se alcance el tope (LinkedIn solo monta un subconjunto de filas en el DOM).
 */
async function collectInboxRowsWithScroll(page: Page, maxThreads: number): Promise<InboxListRow[]> {
  const collectCap = inboxEnvInt("INBOX_LIST_COLLECT_CAP", 220);
  const scrollRounds = inboxEnvInt("INBOX_LIST_SCROLL_ROUNDS", 45);
  const stableNeeded = inboxEnvInt("INBOX_LIST_SCROLL_STABLE_ROUNDS", 5);
  const pauseMs = inboxEnvInt("INBOX_LIST_SCROLL_PAUSE_MS", 140);
  const extractMax = Math.min(500, collectCap + 80);

  const byId = new Map<string, InboxListRow>();
  const order: string[] = [];

  const merge = (batch: InboxListRow[]): boolean => {
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
    const batch = await extractInboxRowsFromListDom(page, extractMax);
    const before = order.length;
    if (merge(batch)) break;
    if (order.length === before) stable += 1;
    else stable = 0;
    if (stable >= stableNeeded) break;
    await scrollMessagingListOneStep(page);
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  const slice = order.slice(0, maxThreads).map((id) => byId.get(id)!);
  console.log(
    `[inbox_sync] ids únicos en lista (scroll): ${order.length}, a procesar: ${slice.length} (maxThreads=${maxThreads})`
  );
  return slice;
}

async function ingestCurrentMessagingThread(
  page: Page,
  sb: SupabaseClient,
  accountId: string,
  rules: DmRuleRow[],
  keywordsAutoReply: boolean,
  peerNameHint?: string | null
): Promise<void> {
  let conversationId = (await extractConversationIdFromMessagingUrl(page)) ?? "";
  if (!conversationId) {
    conversationId = (await extractThreadIdFromMessagingPane(page)) ?? "";
  }
  if (!conversationId) return;
  await page
    .locator(".msg-s-message-list-container, .msg-s-message-list, .msg-thread, main")
    .first()
    .waitFor({ state: "visible", timeout: 12000 })
    .catch(() => {});
  const peerFromHeader = await extractPeerNameFromMessagingThread(page);
  const peerName = peerFromHeader?.trim() || peerNameHint?.trim() || null;
  const hintForBody = peerName;
  let lastRow = await readLastMessageRow(page, hintForBody);
  if (!lastRow) {
    await new Promise((r) => setTimeout(r, 1500));
    lastRow = await readLastMessageRow(page, hintForBody);
  }
  if (lastRow) {
    console.log(
      `[inbox_sync] ingest thread=${conversationId.slice(0, 10)}… dir=${lastRow.direction} chars=${lastRow.text.length}`
    );
    await insertChatRowIfFresh(sb, accountId, conversationId, lastRow.text, lastRow.direction, {
      peer_name: peerName,
    });
  } else {
    console.log(`[inbox_sync] ingest thread=${conversationId.slice(0, 10)}… sin texto de mensaje (selectores/DOM)`);
  }
  if (keywordsAutoReply && rules.length && lastRow && lastRow.direction === "in") {
    const lower = lastRow.text.toLowerCase();
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
      let reply = rule.reply_template.replace(/\{name\}/gi, "there");
      if (rule.use_ai && process.env.GEMINI_API_KEY) {
        reply = await generateDmReply(rule.keyword, lastRow.text);
      }
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
}

async function runMessagingInboxSync(
  page: Page,
  sb: SupabaseClient,
  accountId: string,
  userId: string,
  opts: { keywordsAutoReply: boolean; maxThreads: number }
): Promise<void> {
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1600));
  await page.locator("main, .application-outlet").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await scrollMessagingConversationList(page);

  const { data: rulesRaw } = opts.keywordsAutoReply
    ? await sb.from("keyword_rules").select("*").eq("user_id", userId).eq("rule_type", "dm")
    : { data: [] as DmRuleRow[] };
  const rules = (rulesRaw ?? []) as DmRuleRow[];

  let rows = await collectInboxRowsWithScroll(page, opts.maxThreads);
  if (rows.length === 0) {
    await scrollMessagingConversationList(page);
    await new Promise((r) => setTimeout(r, 500));
    rows = await collectInboxRowsWithScroll(page, opts.maxThreads);
  }

  if (rows.length > 0) {
    for (const row of rows) {
      const url = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(row.conversationId)}/`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 50000 });
      await new Promise((r) => setTimeout(r, 800));
      await ingestCurrentMessagingThread(page, sb, accountId, rules, opts.keywordsAutoReply, row.peerName);
    }
    return;
  }

  const threadUrls = await collectMessagingThreadUrlsFromAnchors(page, opts.maxThreads);
  console.log(`[inbox_sync] enlaces <a> /thread/: ${threadUrls.length}`);
  if (threadUrls.length > 0) {
    for (const threadUrl of threadUrls) {
      await page.goto(threadUrl, { waitUntil: "domcontentloaded", timeout: 50000 });
      await new Promise((r) => setTimeout(r, 700));
      await ingestCurrentMessagingThread(page, sb, accountId, rules, opts.keywordsAutoReply);
    }
    return;
  }

  console.log("[inbox_sync] modo clic + panel (último recurso)");
  const rowLoc = page.locator(
    '[data-view-name="message-list-item"], .msg-conversation-listitem, .msg-conversations-container__conversations-list li'
  );
  const n = await rowLoc.count();
  console.log(`[inbox_sync] filas clicables: ${n}`);
  const maxI = Math.min(Math.max(n, 0), opts.maxThreads);
  for (let i = 0; i < maxI; i++) {
    const items = page.locator(
      '[data-view-name="message-list-item"], .msg-conversation-listitem, .msg-conversations-container__conversations-list li'
    );
    const c = await items.count();
    if (i >= c) break;
    await items.nth(i).click({ timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
    await ingestCurrentMessagingThread(page, sb, accountId, rules, opts.keywordsAutoReply);
  }
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
    const { data: pa, error: pe1 } = await sb
      .from("tasks")
      .update({ ...payload, error_message: "requeued_stale_poll" as const })
      .eq("status", "running")
      .in("action", ["poll_comments", "poll_messages", "sync_inbox"])
      .not("locked_at", "is", null)
      .lt("locked_at", pollIso)
      .select("id");
    const { data: pb, error: pe2 } = await sb
      .from("tasks")
      .update({ ...payload, error_message: "requeued_stale_poll" as const })
      .eq("status", "running")
      .in("action", ["poll_comments", "poll_messages", "sync_inbox"])
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
    return;
  }

  const backoff = Math.min(3600_000, 60_000 * 2 ** (attempts - 1));
  const next = new Date(Date.now() + backoff).toISOString();
  await sb
    .from("tasks")
    .update({ status: "pending", error_message: finalMsg, scheduled_at: next })
    .eq("id", taskId);
  const { enqueueTaskDue } = await import("../queues/redisClient.js");
  await enqueueTaskDue(redis, taskId, new Date(next).getTime());
}

async function completeTask(sb: SupabaseClient, redis: RedisClient, taskId: string) {
  await sb.from("tasks").update({ status: "completed", error_message: null }).eq("id", taskId);
  await removeTaskFromDue(redis, taskId);
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

export async function runOneTask(sb: SupabaseClient, redis: RedisClient, taskId: string): Promise<void> {
  const task = await claimTask(sb, taskId);
  if (!task) return;
  await removeTaskFromDue(redis, taskId).catch(() => {});

  const accountId = task.account_id as string;
  const action = task.action as string;
  console.log("[worker] Ejecutando tarea", taskId.slice(0, 8) + "…", "action=", action);
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
    const { enqueueTaskDue } = await import("../queues/redisClient.js");
    await enqueueTaskDue(redis, taskId, next);
    return;
  }

  let liAt: string;
  try {
    liAt = decryptSecret(account.li_at_cookie);
  } catch {
    await failTask(sb, redis, task, "decrypt_cookie_failed");
    return;
  }

  const gotSlot = await acquireBrowserSlot(redis);
  if (!gotSlot) {
    await sb
      .from("tasks")
      .update({
        status: "pending",
        scheduled_at: new Date(Date.now() + 15_000).toISOString(),
        attempts: Math.max(0, (task.attempts as number) - 1),
      })
      .eq("id", taskId);
    const { enqueueTaskDue } = await import("../queues/redisClient.js");
    await enqueueTaskDue(redis, taskId, Date.now() + 15_000);
    return;
  }

  let browser: Awaited<ReturnType<typeof createContext>> | null = null;
  let traceCtl: TraceController | null = null;

  try {
    let proxyId = account.proxy_id as string | null;
    let proxyRow = proxyId ? await loadProxy(sb, proxyId) : null;

    if (!proxyRow && proxyId) {
      const newPid = await pickProxyForAccount(sb, proxyId);
      if (newPid) {
        await sb.from("linkedin_accounts").update({ proxy_id: newPid }).eq("id", accountId);
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

    const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
    console.log("[worker] Abriendo navegador (headless=", headless, ") para", action);
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

    const messagingSessionActions = new Set(["poll_messages", "poll_comments", "reply_dm", "sync_inbox"]);
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

    const afterSuccess = async (delayHoursForNext: number) => {
      await completeTask(sb, redis, taskId);
      if (enrollmentId) {
        await advanceEnrollmentAfterStep(sb, redis, enrollmentId, delayHoursForNext);
      }
    };

    const getNextStepDelay = async (): Promise<number> => {
      if (!enrollmentId) return 0;
      const { data: en } = await sb.from("campaign_enrollments").select("campaign_id, current_step_index").eq("id", enrollmentId).single();
      if (!en) return 0;
      const { data: steps } = await sb
        .from("campaign_steps")
        .select("delay_hours")
        .eq("campaign_id", en.campaign_id)
        .order("step_order", { ascending: true });
      const nextIdx = (en.current_step_index ?? 0) + 1;
      return steps?.[nextIdx]?.delay_hours ?? 0;
    };

    if (action === "verify_session" || action === "session_check") {
      const r = await openFeed(page);
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
        await afterSuccess(0);
        return;
      }

      let profile: { displayName: string | null; headline: string | null; photoUrl: string | null } = {
        displayName: null,
        headline: null,
        photoUrl: null,
      };
      try {
        profile = await scrapeLoggedInMemberProfile(page);
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
      await afterSuccess(0);
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
      await afterSuccess(0);
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
      await sb.from("linkedin_accounts").update({ last_warmup_at: new Date().toISOString() }).eq("id", accountId);
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "visit_profile") {
      const cap = await checkUnderDailyCap(redis, accountId, "visit");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(6, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await ensureProfilePageLoaded(page, profileUrl);
      await incrementDailyCount(redis, accountId, "visit");
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "follow") {
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
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "like_post") {
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
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "comment_post") {
      const profileUrl = String(payload.profile_url ?? "");
      const tmpl = (payload.message_template as string | undefined) ?? "";
      const text = tmpl
        .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
        .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
        .trim();
      const body =
        text ||
        (process.env.GEMINI_API_KEY
          ? await generateConnectionMessage({
              name: payload.lead_name as string,
              company: payload.lead_company as string,
              title: payload.lead_title as string,
              objective: "short friendly comment on their post",
            })
          : "👍");
      const r = await commentLeadRecentPost(page, profileUrl, body.slice(0, 3000));
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      if (!r.ok) {
        await fail(r.error ?? "comment_failed");
        return;
      }
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "connect") {
      const cap = await checkUnderDailyCap(redis, accountId, "connect");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(7, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await incrementDailyCount(redis, accountId, "connect");
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "send_message") {
      const cap = await checkUnderDailyCap(redis, accountId, "message");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(8, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await incrementDailyCount(redis, accountId, "message");
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "send_message_open_profile") {
      const cap = await checkUnderDailyCap(redis, accountId, "message");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(8, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await incrementDailyCount(redis, accountId, "message");
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "voice_note") {
      const cap = await checkUnderDailyCap(redis, accountId, "message");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(8, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
        await incrementDailyCount(redis, accountId, "message");
        await afterSuccess(await getNextStepDelay());
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
      return;
    }

    if (action === "reply_comment") {
      const profileUrl = String(payload.profile_url ?? "");
      const tmpl = (payload.message_template as string | undefined) ?? "";
      let text = tmpl
        .replace(/\{name\}/gi, String(payload.lead_name ?? ""))
        .replace(/\{company\}/gi, String(payload.lead_company ?? ""))
        .trim();
      if (!text && process.env.GEMINI_API_KEY) {
        text = await generateConnectionMessage({
          name: payload.lead_name as string,
          company: payload.lead_company as string,
          title: payload.lead_title as string,
          objective: "short professional reply to their comment",
        });
      }
      if (!text) text = "Thanks for your comment!";
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
      await afterSuccess(await getNextStepDelay());
      return;
    }

    if (action === "inmail") {
      const cap = await checkUnderDailyCap(redis, accountId, "message");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(8, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await incrementDailyCount(redis, accountId, "message");
      await afterSuccess(await getNextStepDelay());
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
      }
      const r = await publishPost(page, post.content, imagePath);
      if (imagePath) await fs.unlink(imagePath).catch(() => {});
      if (r.softban) {
        await pauseAccountSoftban(sb, accountId);
        await fail("softban");
        return;
      }
      await sb.from("posts").update({ status: r.ok ? "published" : "failed" }).eq("id", postId);
      await afterSuccess(0);
      return;
    }

    if (action === "poll_messages") {
      const maxThreads = inboxPollMessagesMaxThreads();
      const pollMs = inboxPollMessagesPollMs(maxThreads);
      const syncOnly = Boolean(payload.inbox_sync_only ?? payload.sync_only);
      try {
        await runPollWithTimeout(async () => {
          await runMessagingInboxSync(page, sb, accountId, account.user_id as string, {
            keywordsAutoReply: !syncOnly,
            maxThreads,
          });
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
          await runMessagingInboxSync(page, sb, accountId, account.user_id as string, {
            keywordsAutoReply: false,
            maxThreads,
          });
          await completeTask(sb, redis, taskId);
        }, pollMs, "sync_inbox");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
      return;
    }

    if (action === "poll_comments") {
      const pollMs = Number(process.env.POLL_TASK_TIMEOUT_MS ?? 90_000);
      try {
        await runPollWithTimeout(async () => {
          await page.goto("https://www.linkedin.com/notifications/", { waitUntil: "domcontentloaded", timeout: 60000 });
          await new Promise((r) => setTimeout(r, 1200));
          const { data: rules } = await sb
            .from("keyword_rules")
            .select("*")
            .eq("user_id", account.user_id)
            .eq("rule_type", "comment");
          const list = rules ?? [];
          if (!list.length) {
            await completeTask(sb, redis, taskId);
            return;
          }
          const raw = await page
            .locator("main")
            .innerText()
            .catch(() => page.locator("body").innerText().catch(() => ""));
          const lower = raw.toLowerCase();
          const matched = list.filter((rule) => rule.keyword && lower.includes(String(rule.keyword).toLowerCase()));
          if (!matched.length) {
            await completeTask(sb, redis, taskId);
            return;
          }

          const links = page.locator('main a[href*="/feed/update/"], main a[href*="activity"]');
          const n = await links.count();
          let replied = false;
          for (let i = 0; i < Math.min(n, 25); i++) {
            const a = links.nth(i);
            const label = ((await a.innerText().catch(() => "")) + (await a.getAttribute("aria-label").catch(() => ""))).toLowerCase();
            const rule = matched.find((r) => r.keyword && label.includes(String(r.keyword).toLowerCase()));
            if (!rule) continue;
            await a.click({ timeout: 8000 }).catch(() => {});
            await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
            let reply = rule.reply_template.replace(/\{name\}/gi, "there");
            if (rule.use_ai && process.env.GEMINI_API_KEY) {
              const ctx = await page.locator("main").innerText().catch(() => "");
              reply = await generateDmReply(rule.keyword, ctx.slice(0, 4000));
            }
            const box = page
              .locator(
                ".comments-comment-box__form-container [contenteditable='true'], div[role='textbox'][aria-label*='comment' i], .ql-editor"
              )
              .first();
            if (!(await box.isVisible({ timeout: 8000 }).catch(() => false))) {
              throw new Error("poll_comments_comment_box_missing");
            }
            await box.click({ timeout: 5000 }).catch(() => {});
            await box.fill(reply.slice(0, 3000));
            await page.keyboard.press("Enter").catch(() => {});
            await page.getByRole("button", { name: /post|publicar|enviar comentario|comment/i }).first().click({ timeout: 6000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 2500));
            const postUrl = page.url();
            const um = postUrl.match(/feed\/update\/([^/?#]+)/i) ?? postUrl.match(/ugcPost[^?#]+/i);
            const convId = um?.[1] ? `feed:${um[1].slice(0, 120)}` : `comment:${rule.id}:${Date.now()}`;
            await insertChatRowIfFresh(sb, accountId, convId, reply.slice(0, 800), "out", { rule_id: rule.id });
            replied = true;
            break;
          }
          if (!replied) {
            throw new Error("poll_comments_keyword_no_actionable_notification");
          }
          await completeTask(sb, redis, taskId);
        }, pollMs, "poll_comments");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await fail(msg.slice(0, 500));
      }
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
      const cap = await checkUnderDailyCap(redis, accountId, "message");
      if (!cap.ok) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(8, 0, 0, 0);
        await sb
          .from("tasks")
          .update({
            status: "pending",
            scheduled_at: tomorrow.toISOString(),
            attempts: Math.max(0, (task.attempts as number) - 1),
          })
          .eq("id", taskId);
        const { enqueueTaskDue } = await import("../queues/redisClient.js");
        await enqueueTaskDue(redis, taskId, tomorrow.getTime());
        return;
      }
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
      await incrementDailyCount(redis, accountId, "message");
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
      await traceCtl.stopSaveFailure();
      traceCtl = null;
    }
    await failTask(sb, redis, task, msg.slice(0, 500), browser?.page ?? null);
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
  const batch = orderedIds.slice(0, maxParallel);

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
    await Promise.all(batch.map((taskId) => runOneTask(sb, redis, taskId)));
  }
}
