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

async function fetchVoyagerMeInPage(page: Page): Promise<unknown | null> {
  return page.evaluate(async () => {
    try {
      const r = await fetch("https://www.linkedin.com/voyager/api/me", {
        credentials: "include",
        headers: {
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "x-restli-protocol-version": "2.0.0",
        },
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  });
}

async function scrapeProfileDom(page: Page): Promise<LoggedInProfileScrape> {
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

  const rawJson = await fetchVoyagerMeInPage(page);
  const fromApi = parseVoyagerMe(rawJson);
  const publicIdentifier = fromApi.publicIdentifier;
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
