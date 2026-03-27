/**
 * LinkedIn inbox scraper (Playwright).
 * Plain module — no HTTP framework. Use with an authenticated Page (e.g. after cookie injection).
 */

import type { Locator, Page } from "playwright";

// ——— Types (DB-ready JSON) ———

export interface ScrapedConversation {
  conversationId: string;
  participantNames: string[];
  lastMessagePreview: string;
  timestamp: string;
}

export interface ScrapedMessage {
  messageId: string;
  senderName: string;
  senderProfileUrl: string | null;
  text: string;
  timestamp: string;
}

export class InboxScraperError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NAVIGATION"
      | "LIST_NOT_FOUND"
      | "OPEN_CONVERSATION"
      | "EMPTY_INBOX"
      | "SCRAPE_MESSAGES"
  ) {
    super(message);
    this.name = "InboxScraperError";
  }
}

const MESSAGING_URL = "https://www.linkedin.com/messaging/";

/** Human-ish delay between scroll steps (ms). */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries<T>(fn: () => Promise<T>, attempts: number, label: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await delay(400 + i * 200);
    }
  }
  throw last instanceof Error ? last : new Error(`${label}: ${String(last)}`);
}

// ——— Sidebar / list discovery (multiple strategies) ———

function conversationRowLocator(page: Page): Locator {
  return page.locator(
    [
      '[data-view-name="message-list-item"]',
      '[data-view-name="message-list-item-conversation"]',
      "li.msg-conversation-card",
      ".msg-conversation-listitem",
      ".msg-conversations-container__conversations-list > li",
      "ul.msg-conversations-container__conversations-list li",
    ].join(", ")
  );
}

function listScrollRoot(page: Page): Locator {
  return page
    .locator(
      [
        ".msg-conversations-container__conversations-list",
        "[data-view-name='message-list']",
        "aside .scaffold-layout__list",
        "ul.msg-conversations-container__conversations-list",
        "[role='navigation'] ~ div [role='list']",
      ].join(", ")
    )
    .first();
}

// ——— 1) loadLinkedinInbox ———

/**
 * Navigates to LinkedIn messaging and waits until the inbox shell is usable.
 */
export async function loadLinkedinInbox(page: Page, options?: { timeoutMs?: number }): Promise<void> {
  const timeout = options?.timeoutMs ?? 60_000;
  await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout });
  await page.locator("main").first().waitFor({ state: "visible", timeout: Math.min(25_000, timeout) }).catch(() => {});

  const listHint = listScrollRoot(page);
  const rows = conversationRowLocator(page);
  const deadline = Date.now() + Math.min(30_000, timeout);
  const started = Date.now();
  while (Date.now() < deadline) {
    const urlOk = page.url().includes("/messaging");
    const listOk = await listHint.isVisible({ timeout: 2000 }).catch(() => false);
    const anyRow = (await rows.count()) > 0;
    const mainOk = await page.locator("main").first().isVisible({ timeout: 1000 }).catch(() => false);
    // Empty inbox: shell loads with no rows but we are on messaging.
    if (urlOk && mainOk && (listOk || anyRow)) {
      await delay(500);
      return;
    }
    if (urlOk && mainOk && !anyRow) {
      const emptyHint = await page
        .getByText(/no messages|sin mensajes|start a conversation|inicia una conversación/i)
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
      if (emptyHint || listOk) {
        await delay(400);
        return;
      }
      // Sidebar markup changed: after ~12s on /messaging + main, proceed (may be 0 conversations).
      if (Date.now() - started > 12_000) {
        await delay(400);
        return;
      }
    }
    await delay(400);
  }

  throw new InboxScraperError(
    "Messaging UI did not become ready. Check login, captcha, or LinkedIn layout.",
    "LIST_NOT_FOUND"
  );
}

// ——— 2) getConversations ———

/**
 * Scrapes the left conversation list. Uses data-view-name, roles, and thread URLs where possible.
 */
export async function getConversations(page: Page): Promise<ScrapedConversation[]> {
  const data = await page.evaluate(() => {
    type Row = {
      conversationId: string;
      participantNames: string[];
      lastMessagePreview: string;
      timestamp: string;
    };
    const out: Row[] = [];
    const seen = new Set<string>();

    const selectors = [
      '[data-view-name="message-list-item"]',
      '[data-view-name="message-list-item-conversation"]',
      "li.msg-conversation-card",
      ".msg-conversation-listitem",
      ".msg-conversations-container__conversations-list > li",
      "ul.msg-conversations-container__conversations-list li",
    ];

    const rowEls: Element[] = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (rowEls.includes(el)) return;
        if (el.closest(".msg-s-message-list-container")) return;
        rowEls.push(el);
      });
    }

    const extractThreadId = (root: Element): string => {
      const html = root.outerHTML;
      let m = html.match(/\/messaging\/thread\/([^"'\\s&?#%<>]+)/i);
      if (m?.[1]) return decodeURIComponent(m[1]);
      const a = root.querySelector("a[href*='/messaging/thread/']") as HTMLAnchorElement | null;
      if (a?.href) {
        m = a.href.match(/\/messaging\/thread\/([^/?#]+)/i);
        if (m?.[1]) return decodeURIComponent(m[1]);
      }
      return "";
    };

    const nameFromRow = (row: Element): string[] => {
      const nameEl =
        row.querySelector(".msg-conversation-listitem__participant-names") ||
        row.querySelector("[class*='participant-names']") ||
        row.querySelector("h3") ||
        row.querySelector("[title]") ||
        row.querySelector("span[dir='auto']");
      const raw = nameEl?.textContent?.replace(/\s+/g, " ").trim() || "";
      if (!raw) return [];
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    };

    const timeFromRow = (row: Element): string => {
      const t =
        row.querySelector("time")?.getAttribute("datetime") ||
        row.querySelector("time")?.textContent?.trim() ||
        row.querySelector("[class*='timestamp']")?.textContent?.trim() ||
        "";
      return (t || "").replace(/\s+/g, " ").trim();
    };

    for (const row of rowEls) {
      const conversationId = extractThreadId(row);
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);

      const fullText = (row.textContent || "").replace(/\s+/g, " ").trim();
      const names = nameFromRow(row);
      let preview = fullText;
      for (const n of names) {
        preview = preview.replace(n, "").trim();
      }
      preview = preview.replace(/^[,·•\s]+/, "").slice(0, 500);

      out.push({
        conversationId,
        participantNames: names.length ? names : [fullText.slice(0, 80) || "Unknown"],
        lastMessagePreview: preview || "—",
        timestamp: timeFromRow(row) || "",
      });
    }

    return out;
  });

  return data;
}

// ——— 3) openConversation ———

/**
 * Clicks a conversation row and waits for the thread panel to load.
 * Pass a Locator pointing at the list row (e.g. conversationRowLocator(page).nth(i)).
 */
export async function openConversation(page: Page, conversationElement: Locator, options?: { timeoutMs?: number }): Promise<void> {
  const timeout = options?.timeoutMs ?? 25_000;
  const count = await conversationElement.count();
  if (count < 1) {
    throw new InboxScraperError("Conversation locator matches no element.", "OPEN_CONVERSATION");
  }

  await conversationElement.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
  await conversationElement.click({ timeout: 12_000 });

  await withRetries(
    async () => {
      const urlHasThread = /\/messaging\/thread\//i.test(page.url());
      const pane = page.locator(
        [
          '[data-view-name="message-pane"]',
          ".msg-s-message-list-container",
          ".msg-s-message-list",
          '[role="region"]',
        ].join(", ")
      );
      const visible = urlHasThread || (await pane.first().isVisible({ timeout: 3000 }).catch(() => false));
      if (!visible) throw new Error("thread_not_visible");
      return true;
    },
    4,
    "openConversation"
  );

  await page
    .locator(".msg-s-message-list-container, .msg-s-message-list, main")
    .first()
    .waitFor({ state: "visible", timeout })
    .catch(() => {});
  await delay(400);
}

// ——— 4) scrapeMessages ———

/**
 * Extracts visible messages from the open thread. Scroll position matters — call after loadFullConversation for full history.
 */
export async function scrapeMessages(page: Page): Promise<ScrapedMessage[]> {
  const raw = await page.evaluate(() => {
    type M = {
      messageId: string;
      senderName: string;
      senderProfileUrl: string | null;
      text: string;
      timestamp: string;
    };
    const items: M[] = [];

    const candidates = Array.from(
      document.querySelectorAll(
        [
          ".msg-s-event-listitem",
          "li.msg-s-message-list__event",
          "[data-view-name='message-list-item-event']",
          "li[class*='msg-s-message-list']",
        ].join(", ")
      )
    ).filter((el) => !el.closest(".msg-conversations-container__conversations-list"));

    const profileHref = (root: Element): string | null => {
      const a = root.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null;
      if (!a?.href) return null;
      try {
        const u = new URL(a.href, location.origin);
        if (u.pathname.includes("/in/")) return u.origin + u.pathname.split("?")[0];
      } catch {
        /* ignore */
      }
      return null;
    };

    const bodyText = (root: Element): string => {
      const prefer = root.querySelector(
        [
          "[class*='msg-s-event-listitem__message-body']",
          "[class*='message-body']",
          ".msg-s-message-group__message",
          "p.msg-s-message-group__text",
        ].join(", ")
      );
      const t = (prefer?.textContent || root.textContent || "").replace(/\s+/g, " ").trim();
      return t;
    };

    const senderName = (root: Element): string => {
      const named = root.querySelector(
        [
          ".msg-s-message-group__name",
          "[class*='profile-name']",
          "a[href*='/in/'] span",
          "span[dir='auto']",
        ].join(", ")
      );
      const n = named?.textContent?.replace(/\s+/g, " ").trim() || "";
      if (n) return n.slice(0, 200);
      const fallback = bodyText(root).slice(0, 40);
      return fallback || "Unknown";
    };

    const timeStr = (root: Element): string => {
      const timeEl = root.querySelector("time");
      return (
        timeEl?.getAttribute("datetime") ||
        timeEl?.textContent?.replace(/\s+/g, " ").trim() ||
        ""
      );
    };

    const msgId = (root: Element, index: number): string => {
      const urn =
        root.getAttribute("data-event-urn") ||
        root.getAttribute("data-msg-id") ||
        root.getAttribute("id") ||
        "";
      if (urn) return urn.slice(0, 400);
      const t = timeStr(root);
      const x = bodyText(root).slice(0, 80);
      return `synthetic:${index}:${t}:${x.length}`;
    };

    candidates.forEach((el, index) => {
      const text = bodyText(el);
      if (!text || text.length < 1) return;
      items.push({
        messageId: msgId(el, index),
        senderName: senderName(el),
        senderProfileUrl: profileHref(el),
        text: text.slice(0, 8000),
        timestamp: timeStr(el),
      });
    });

    return items;
  });

  return raw;
}

// ——— 5) loadFullConversation ———

/**
 * Scrolls the thread container until message list height stabilizes (infinite scroll / lazy load).
 */
export async function loadFullConversation(page: Page, options?: { maxRounds?: number; stableRounds?: number }): Promise<void> {
  const maxRounds = options?.maxRounds ?? 80;
  const needStable = options?.stableRounds ?? 4;

  const scroller = page
    .locator(
      [
        ".msg-s-message-list-container",
        "ul.msg-s-message-list",
        ".msg-s-message-list",
        '[data-view-name="message-pane"] div[class*="scroll"]',
      ].join(", ")
    )
    .first();

  if (!(await scroller.isVisible({ timeout: 8000 }).catch(() => false))) {
    await page.keyboard.press("End").catch(() => {});
    await delay(600);
  }

  let stable = 0;
  let lastHeight = -1;

  for (let i = 0; i < maxRounds; i++) {
    const height = await scroller
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollHeight;
      })
      .catch(() => -1);

    await page.keyboard.press("End").catch(() => {});
    await delay(280 + Math.min(i, 20) * 15);

    if (height <= 0) {
      stable += 1;
      if (stable >= needStable) break;
      continue;
    }

    if (height === lastHeight) stable += 1;
    else {
      stable = 0;
      lastHeight = height;
    }
    if (stable >= needStable) break;
  }
}

// ——— 6) getConversationMessages ———

/**
 * Opens a row, scrolls to load history, returns all scraped messages.
 * If the thread is already open, pass only `page` and use {@link loadFullConversation} + {@link scrapeMessages} yourself,
 * or pass `skipOpen: true` with a pre-opened thread.
 */
export async function getConversationMessages(
  page: Page,
  conversationRow: Locator,
  options?: { timeoutMs?: number; skipOpen?: boolean }
): Promise<ScrapedMessage[]> {
  try {
    if (!options?.skipOpen) {
      await openConversation(page, conversationRow, { timeoutMs: options?.timeoutMs });
    }
    await loadFullConversation(page);
    await delay(350);
    const messages = await scrapeMessages(page);
    return messages;
  } catch (e) {
    if (e instanceof InboxScraperError) throw e;
    throw new InboxScraperError(
      e instanceof Error ? e.message : String(e),
      "SCRAPE_MESSAGES"
    );
  }
}

/**
 * Opens a conversation by thread id (navigates directly). Useful when you only have `conversationId` from DB.
 */
export async function openConversationByThreadId(page: Page, conversationId: string, options?: { timeoutMs?: number }): Promise<void> {
  const enc = encodeURIComponent(conversationId);
  const url = `https://www.linkedin.com/messaging/thread/${enc}/`;
  const timeout = options?.timeoutMs ?? 50_000;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page
    .locator(".msg-s-message-list-container, .msg-s-message-list, main")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {});
  await delay(500);
}

/**
 * Full thread scrape after direct navigation by id.
 */
export async function getConversationMessagesByThreadId(
  page: Page,
  conversationId: string,
  options?: { timeoutMs?: number }
): Promise<ScrapedMessage[]> {
  await openConversationByThreadId(page, conversationId, options);
  await loadFullConversation(page);
  await delay(350);
  return scrapeMessages(page);
}

/** Locator factory for list rows (use with `.nth(i)`). */
export { conversationRowLocator, listScrollRoot };
