/**
 * Sincroniza la lista de conversaciones vía API Voyager con solo li_at (+ JSESSIONID obtenido en bootstrap).
 * Misma idea que Prosp u otras herramientas: sesión HTTP, sin Playwright.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetch, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import { parseVoyagerConversationList } from "../lib/voyagerMessagingParse.js";
import type { InboxListRow } from "../types/inboxList.js";
import { bulkUpsertInboxConversationsOrdered } from "./inboxBulkUpsert.js";
import type { ProxyRow } from "./proxyAssign.js";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function serializeCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absorbSetCookie(jar: Map<string, string>, res: { headers: { getSetCookie?: () => string[] } }): void {
  const getter = res.headers.getSetCookie;
  const lines = typeof getter === "function" ? getter.call(res.headers) : [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1);
    const semi = rest.indexOf(";");
    const value = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
    if (name && value) jar.set(name, value);
  }
}

function csrfFromJar(jar: Map<string, string>): string | null {
  const raw = jar.get("JSESSIONID");
  if (!raw) return null;
  return raw.replace(/^"/, "").replace(/"$/, "").trim() || null;
}

async function bootstrapLinkedInMessaging(
  liAt: string,
  dispatcher?: Dispatcher
): Promise<{ cookieHeader: string; csrf: string } | null> {
  const jar = new Map<string, string>();
  jar.set("li_at", liAt);

  let url = "https://www.linkedin.com/messaging/";
  for (let hop = 0; hop < 12; hop++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      dispatcher,
      headers: {
        Cookie: serializeCookieJar(jar),
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    absorbSetCookie(jar, res);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      url = new URL(loc, url).href;
      continue;
    }

    const html = await res.text();
    let csrf = csrfFromJar(jar);
    if (!csrf) {
      const m =
        /"csrfToken":"(ajax:[^"]+)"/.exec(html) ||
        /csrfToken":"(ajax:[^"]+)"/.exec(html) ||
        /JSESSIONID[^=]*=\s*"?([^";\s]+)/.exec(html);
      if (m?.[1]) {
        csrf = m[1].replace(/^"/, "").replace(/"$/, "");
        jar.set("JSESSIONID", csrf.includes("ajax:") ? `"${csrf}"` : csrf);
      }
    } else {
      csrf = csrfFromJar(jar);
    }

    if (!csrf) {
      console.warn("[inbox_http] bootstrap: sin csrf/JSESSIONID");
      return null;
    }

    return { cookieHeader: serializeCookieJar(jar), csrf };
  }

  return null;
}

async function fetchVoyagerConversationsPage(
  cookieHeader: string,
  csrf: string,
  start: number,
  count: number,
  dispatcher?: Dispatcher
): Promise<unknown | null> {
  const u = `https://www.linkedin.com/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=${start}&count=${count}`;
  const r = await fetch(u, {
    dispatcher,
    headers: {
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "csrf-token": csrf,
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      Referer: "https://www.linkedin.com/messaging/",
      Origin: "https://www.linkedin.com",
      "User-Agent": CHROME_UA,
      Cookie: cookieHeader,
    },
  });
  if (!r.ok) {
    return { _status: r.status };
  }
  try {
    return await r.json();
  } catch {
    return { _error: "json_parse" };
  }
}

function buildDispatcher(proxy: ProxyRow | null): Dispatcher | undefined {
  if (!proxy?.host) return undefined;
  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : "";
  const u = `http://${auth}${proxy.host}:${proxy.port}`;
  return new ProxyAgent(u);
}

async function runVoyagerListHttp(
  liAt: string,
  maxThreads: number,
  proxy: ProxyRow | null
): Promise<InboxListRow[] | null> {
  const dispatcher = buildDispatcher(proxy);
  const boot = await bootstrapLinkedInMessaging(liAt, dispatcher);
  if (!boot) return null;

  const pageSize = 100;
  const maxPages = Math.ceil(maxThreads / pageSize);
  const allRows: InboxListRow[] = [];
  const seen = new Set<string>();

  for (let pg = 0; pg < maxPages; pg++) {
    const start = pg * pageSize;
    const count = Math.min(pageSize, maxThreads - allRows.length);
    const body = await fetchVoyagerConversationsPage(boot.cookieHeader, boot.csrf, start, count, dispatcher);

    if (!body || typeof body !== "object") {
      if (pg === 0) return null;
      break;
    }
    const b = body as Record<string, unknown>;
    if (b._error || (typeof b._status === "number" && (b._status as number) >= 400)) {
      console.log(`[inbox_http] Voyager: ${b._error ?? b._status}`);
      if (pg === 0) return null;
      break;
    }

    const rows = parseVoyagerConversationList(body, maxThreads - allRows.length);
    if (pg === 0 && rows.length === 0) {
      console.log("[inbox_http] página 0 sin conversaciones");
      return null;
    }

    for (const r of rows) {
      if (!seen.has(r.conversationId)) {
        seen.add(r.conversationId);
        allRows.push(r);
      }
    }

    if (rows.length < count || allRows.length >= maxThreads) break;
    if (pg < maxPages - 1) await new Promise((r) => setTimeout(r, 120));
  }

  return allRows.length > 0 ? allRows : null;
}

export type TrySyncInboxHttpResult =
  | { ok: true; count: number }
  | { ok: false; error: string; fallback: true };

/**
 * Intenta volcar la lista de inbox solo con HTTP (li_at). Si LinkedIn no coopera, devuelve fallback.
 */
export async function trySyncInboxListHttp(
  sb: SupabaseClient,
  accountId: string,
  liAt: string,
  maxThreads: number,
  proxy: ProxyRow | null
): Promise<TrySyncInboxHttpResult> {
  const rows = await runVoyagerListHttp(liAt, maxThreads, proxy);
  if (!rows) {
    return { ok: false, error: "voyager_http_unavailable", fallback: true };
  }
  await bulkUpsertInboxConversationsOrdered(sb, accountId, rows, Date.now());
  console.log(`[inbox_http] OK ${rows.length} conversaciones (sin Playwright)`);
  return { ok: true, count: rows.length };
}
