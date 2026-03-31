import type { Page } from "playwright";
import { randomDelay } from "./humanize.js";

export type LoggedInProfileScrape = {
  displayName: string | null;
  headline: string | null;
  photoUrl: string | null;
};

type VoyagerMeJson = Record<string, unknown>;

function buildVectorImageUrl(pic: unknown): string | null {
  if (!pic || typeof pic !== "object") return null;
  const p = pic as Record<string, unknown>;
  const vi = (p["com.linkedin.common.VectorImage"] as Record<string, unknown> | undefined) ?? p;
  const root = typeof vi.rootUrl === "string" ? vi.rootUrl : null;
  const arts = vi.artifacts as Array<Record<string, unknown>> | undefined;
  if (!root || !Array.isArray(arts) || arts.length === 0) return null;
  const best = [...arts].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
  const seg = best?.fileIdentifyingUrlPathSegment;
  if (typeof seg !== "string" || !seg) return null;
  return root.endsWith("/") ? `${root}${seg}` : `${root}/${seg}`;
}

/** Extrae MiniProfile del JSON de /voyager/api/me (formato varía). */
function parseVoyagerMe(body: unknown): LoggedInProfileScrape & { publicIdentifier: string | null } {
  const out: LoggedInProfileScrape & { publicIdentifier: string | null } = {
    displayName: null,
    headline: null,
    photoUrl: null,
    publicIdentifier: null,
  };
  if (!body || typeof body !== "object") return out;

  const applyMini = (o: Record<string, unknown>) => {
    const fn = typeof o.firstName === "string" ? o.firstName : "";
    const ln = typeof o.lastName === "string" ? o.lastName : "";
    const name = `${fn} ${ln}`.trim();
    if (name) out.displayName = name;
    const occ = o.occupation ?? o.headline;
    if (typeof occ === "string" && occ.trim()) out.headline = occ.trim();
    if (typeof o.publicIdentifier === "string" && o.publicIdentifier && o.publicIdentifier !== "me") {
      out.publicIdentifier = o.publicIdentifier;
    }
    const ph = buildVectorImageUrl(o.picture) ?? buildVectorImageUrl(o.profilePicture);
    if (ph) out.photoUrl = ph;
  };

  const b = body as VoyagerMeJson;
  const included = b.included;
  if (Array.isArray(included)) {
    for (const item of included) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const t = String(o.$type ?? "");
      const looksMini =
        t.includes("MiniProfile") ||
        (typeof o.firstName === "string" && typeof o.publicIdentifier === "string");
      if (looksMini) {
        applyMini(o);
        break;
      }
    }
  }

  const mp = b.miniProfile;
  if (mp && typeof mp === "object") applyMini(mp as Record<string, unknown>);

  return out;
}

const VOYAGER_ME_TIMEOUT_MS = 14_000;

async function fetchVoyagerMeInPage(
  page: Page,
  timeoutMs: number = VOYAGER_ME_TIMEOUT_MS
): Promise<unknown | null> {
  return page.evaluate(async (ms: number) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch("https://www.linkedin.com/voyager/api/me", {
        credentials: "include",
        signal: ac.signal,
        headers: {
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "x-restli-protocol-version": "2.0.0",
        },
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, timeoutMs);
}

/** Slug /in/{id}/ desde la URL o enlaces del DOM (feed o actividad). */
async function extractPublicIdentifierFromPage(page: Page): Promise<string | null> {
  const fromUrl = page.url().match(/linkedin\.com\/in\/([^/?#]+)\//i);
  if (fromUrl) {
    const id = decodeURIComponent(fromUrl[1]!);
    if (id.toLowerCase() !== "me" && !id.includes("company") && !id.includes("school")) {
      return id;
    }
  }
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('header a[href*="/in/"], main a[href*="/in/"]');
    for (const a of nodes) {
      const h = a.getAttribute("href") || "";
      const m = h.match(/\/in\/([^/?#]+)/i);
      if (!m) continue;
      const id = decodeURIComponent(m[1]!);
      if (id.toLowerCase() === "me") continue;
      if (id.includes("company") || id.includes("school")) continue;
      return id;
    }
    return null;
  });
}

export async function scrapeProfileDom(page: Page): Promise<LoggedInProfileScrape> {
  const nameSelectors = [
    "h1.text-heading-xlarge",
    "h1.inline",
    '[data-view-name="profile-top-card"] h1',
    "h1[class*='top-card']",
    "main h1",
    '[class*="top-card"] h1',
  ];
  let displayName: string | null = null;
  for (const sel of nameSelectors) {
    const raw = await page.locator(sel).first().innerText().catch(() => "");
    const t = raw?.replace(/\s+/g, " ").trim() ?? "";
    if (t.length >= 2 && t.length < 200) {
      displayName = t;
      break;
    }
  }

  const headlineSelectors = [
    "div.text-body-medium.break-words",
    ".pv-text-details__left-panel .text-body-medium",
    '[class*="top-card"] .text-body-medium',
    "main .text-body-medium",
  ];
  let headline: string | null = null;
  for (const sel of headlineSelectors) {
    const loc = page.locator(sel);
    const n = await loc.count();
    for (let i = 0; i < Math.min(n, 8); i++) {
      const raw = await loc.nth(i).innerText().catch(() => "");
      const t = raw?.replace(/\s+/g, " ").trim() ?? "";
      if (t.length < 3 || t.length > 600) continue;
      if (displayName && t === displayName) continue;
      headline = t;
      break;
    }
    if (headline) break;
  }

  const photoSelectors = [
    "img.pv-top-card-profile-picture__image",
    "button.pvs-header__image img",
    ".pv-top-card-profile-picture img",
    "img.profile-photo-edit__preview",
    '[class*="profile-photo"] img',
    '[data-view-name="profile-top-card"] img',
    "img[class*='EntityPhoto']",
  ];
  let photoUrl: string | null = null;
  for (const sel of photoSelectors) {
    const src = await page.locator(sel).first().getAttribute("src").catch(() => null);
    if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
      photoUrl = src;
      break;
    }
  }

  if (!displayName) {
    const h1role = await page.getByRole("heading", { level: 1 }).first().innerText().catch(() => "");
    const t = h1role?.replace(/\s+/g, " ").trim() ?? "";
    if (t.length >= 2 && t.length < 200) displayName = t;
  }

  if (!displayName) {
    const og = await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null);
    if (og) {
      const first = og.split(/\s*\|\s*/)[0]?.split(/\s+-\s+/)[0]?.trim() ?? "";
      if (first.length >= 2 && first.length < 200) displayName = first;
    }
  }

  if (!photoUrl) {
    const ogImg = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);
    if (ogImg && (ogImg.startsWith("http://") || ogImg.startsWith("https://"))) {
      photoUrl = ogImg;
    }
  }

  return { displayName, headline, photoUrl };
}

function mergeProfile(
  a: LoggedInProfileScrape,
  b: LoggedInProfileScrape
): LoggedInProfileScrape {
  return {
    displayName: a.displayName ?? b.displayName,
    headline: a.headline ?? b.headline,
    photoUrl: a.photoUrl ?? b.photoUrl,
  };
}

/**
 * Obtiene nombre, titular y foto sin usar /in/me/ (suele provocar ERR_TOO_MANY_REDIRECTS en Playwright).
 * 1) /feed/ + Voyager /voyager/api/me
 * 2) Si hace falta, /in/{publicIdentifier}/ + scraping DOM
 */
export async function scrapeLoggedInMemberProfile(page: Page): Promise<LoggedInProfileScrape> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await randomDelay(400, 1200);

  const rawJson = await fetchVoyagerMeInPage(page, VOYAGER_ME_TIMEOUT_MS);
  const fromApi = parseVoyagerMe(rawJson);
  let publicIdentifier = fromApi.publicIdentifier;
  if (!publicIdentifier) {
    publicIdentifier = await extractPublicIdentifierFromPage(page);
  }
  let merged: LoggedInProfileScrape = {
    displayName: fromApi.displayName,
    headline: fromApi.headline,
    photoUrl: fromApi.photoUrl,
  };

  const needDom =
    !!publicIdentifier &&
    (!merged.displayName || !merged.headline || !merged.photoUrl);

  if (needDom && publicIdentifier) {
    try {
      const url = `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier)}/`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await randomDelay(500, 1500);
      const dom = await scrapeProfileDom(page);
      merged = mergeProfile(merged, dom);
    } catch {
      // redirect / captcha / timeout: nos quedamos con lo que devolvió Voyager
    }
  }

  if (!merged.displayName && !merged.headline && !merged.photoUrl) {
    try {
      const domOnly = await scrapeProfileDom(page);
      merged = mergeProfile(merged, domOnly);
    } catch {
      /* empty */
    }
  }

  if (!merged.displayName || !merged.photoUrl) {
    const slug = await page.evaluate(() => {
      const nodes = document.querySelectorAll('header a[href*="/in/"]');
      for (const a of nodes) {
        const h = a.getAttribute("href") || "";
        const m = h.match(/\/in\/([^/?#]+)/i);
        if (!m) continue;
        const id = decodeURIComponent(m[1]);
        if (id.toLowerCase() === "me") continue;
        if (id.includes("company") || id.includes("school")) continue;
        return id;
      }
      return null;
    });
    if (slug) {
      try {
        await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        await randomDelay(500, 1500);
        merged = mergeProfile(merged, await scrapeProfileDom(page));
      } catch {
        /* empty */
      }
    }
  }

  return merged;
}

export type ScrapedActivityPost = {
  content: string;
  linkedin_activity_url: string | null;
  linkedin_activity_urn: string | null;
};

function urnFromLinkedInUrl(url: string): string | null {
  const m = url.match(/urn:li:[^/?#]+/i);
  return m ? m[0]! : null;
}

export type ScrapeActivityPostsResult = {
  posts: ScrapedActivityPost[];
  publicIdentifier: string | null;
};

/**
 * Abre la actividad reciente del miembro logueado e intenta extraer publicaciones (texto + enlace).
 * Depende del DOM de LinkedIn; puede devolver pocos o ningún ítem si cambia la UI.
 */
export async function scrapeLoggedInMemberActivityPosts(
  page: Page,
  maxPosts = 50
): Promise<ScrapeActivityPostsResult> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await randomDelay(400, 1200);
  const rawJson = await fetchVoyagerMeInPage(page, VOYAGER_ME_TIMEOUT_MS);
  const fromApi = parseVoyagerMe(rawJson);
  let pid: string | null = fromApi.publicIdentifier;
  if (!pid) {
    pid = await extractPublicIdentifierFromPage(page);
  }
  if (!pid) {
    return { posts: [], publicIdentifier: null };
  }

  const activityUrl = `https://www.linkedin.com/in/${encodeURIComponent(pid)}/recent-activity/all/`;
  await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  await randomDelay(1200, 2200);

  pid = (await extractPublicIdentifierFromPage(page)) ?? pid;

  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 1400);
    await randomDelay(350, 700);
  }

  const raw = await page.evaluate(
    ({ max, publicId }: { max: number; publicId: string }) => {
      const out: { content: string; url: string }[] = [];
      const seen = new Set<string>();
      const seenCk = new Set<string>();

      const abs = (href: string) => {
        if (href.startsWith("/")) return `https://www.linkedin.com${href}`;
        return href;
      };

      const isGenericActivityAll = (href: string) => {
        try {
          const u = new URL(href, "https://www.linkedin.com");
          return /\/recent-activity\/all\/?$/i.test(u.pathname);
        } catch {
          return false;
        }
      };

      /** LinkedIn mete parte del feed en shadow roots; querySelector plano no los ve. */
      const queryDeepAll = (sel: string): Element[] => {
        const acc: Element[] = [];
        const visit = (root: Document | ShadowRoot) => {
          try {
            root.querySelectorAll(sel).forEach((el) => acc.push(el));
          } catch {
            /* selector inválido en algún root */
          }
          root.querySelectorAll("*").forEach((host) => {
            const sr = (host as HTMLElement).shadowRoot;
            if (sr) visit(sr);
          });
        };
        visit(document);
        return acc;
      };

      const hrefLooksLikePost = (href: string) => {
        const h = href.toLowerCase();
        return (
          h.includes("/feed/update/") ||
          h.includes("urn:li:activity") ||
          h.includes("ugcpost") ||
          h.includes("/posts/") ||
          h.includes("activityurn") ||
          h.includes("detail/activity-") ||
          h.includes("activity-")
        );
      };

      const phaseA = () => {
        const main = document.querySelector("main");
        const anchors = main
          ? main.querySelectorAll("a[href]")
          : document.querySelectorAll("a[href]");
        for (const a of anchors) {
          if (out.length >= max) break;
          const el = a as HTMLAnchorElement;
          let href = el.getAttribute("href") || "";
          if (!hrefLooksLikePost(href)) continue;
          href = abs(href);
          if (!href.startsWith("http")) continue;
          const key = href.split("?")[0] ?? href;
          if (seen.has(key)) continue;
          const root =
            el.closest("article") ??
            el.closest('[role="article"]') ??
            el.closest("[class*='feed-shared-update-v2']") ??
            el.closest("[class*='update-components']") ??
            el.closest("div");
          let text = (root?.innerText || "").replace(/\s+/g, " ").trim();
          if (text.length < 12) continue;
          text = text.slice(0, 12000);
          seen.add(key);
          out.push({ content: text, url: key });
        }
      };

      const MIN_POST_CHARS = 12;
      const CLIMB_MIN_CHARS = 48;

      const phaseB = () => {
        const anchors = queryDeepAll("a[componentkey]");
        for (const a of anchors) {
          if (out.length >= max) break;
          const el = a as HTMLAnchorElement;
          const ck = el.getAttribute("componentkey");
          if (!ck || seenCk.has(ck)) continue;

          let href = el.getAttribute("href") || "";
          href = abs(href);
          if (!href.startsWith("http")) continue;

          const label = (el.innerText || "").replace(/\s+/g, " ").trim();
          const generic = isGenericActivityAll(href);

          if (generic) {
            let text: string;
            if (label.length >= 28) {
              const root =
                el.closest("article") ??
                el.closest('[role="article"]') ??
                el.closest("[class*='feed-shared-update-v2']") ??
                el.closest("[class*='update-components']") ??
                el.closest("div");
              text = (root?.innerText || el.innerText || "").replace(/\s+/g, " ").trim();
            } else {
              let root: Element | null = null;
              let p: Element | null = el;
              for (let i = 0; i < 18 && p; i++) {
                const he = p as HTMLElement;
                const t = (he.innerText || "").replace(/\s+/g, " ").trim();
                if (t.length >= CLIMB_MIN_CHARS) {
                  root = p;
                  break;
                }
                p = p.parentElement;
              }
              if (!root) continue;
              text = ((root as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
            }
            if (text.length < MIN_POST_CHARS) continue;
            text = text.slice(0, 12000);
            const synthetic = `https://www.linkedin.com/in/${encodeURIComponent(
              publicId
            )}/recent-activity/all/#ck=${ck}`;
            if (seen.has(synthetic)) continue;
            seen.add(synthetic);
            seenCk.add(ck);
            out.push({ content: text, url: synthetic });
            continue;
          }

          const key = href.split("?")[0] ?? href;
          if (seen.has(key)) continue;
          try {
            const u = new URL(href, "https://www.linkedin.com");
            if (/^\/in\/[^/]+\/?$/i.test(u.pathname)) continue;
          } catch {
            /* seguir */
          }
          const root =
            el.closest("article") ??
            el.closest('[role="article"]') ??
            el.closest("[class*='feed-shared-update-v2']") ??
            el.closest("[class*='update-components']") ??
            el.closest("div");
          let text = (root?.innerText || "").replace(/\s+/g, " ").trim();
          if (text.length < MIN_POST_CHARS) continue;
          text = text.slice(0, 12000);
          seen.add(key);
          seenCk.add(ck);
          out.push({ content: text, url: key });
        }
      };

      phaseA();
      phaseB();

      return out;
    },
    { max: maxPosts, publicId: pid }
  );

  const posts = raw.map((r) => ({
    content: r.content,
    linkedin_activity_url: r.url,
    linkedin_activity_urn: r.url ? urnFromLinkedInUrl(r.url) : null,
  }));

  return { posts, publicIdentifier: pid };
}
