/**
 * Resuelve fotos de perfil de LinkedIn SIN cookies / sin sesión autenticada.
 * No consume cupo de visitas LinkedIn.
 *
 * Estrategias (en orden, la primera que devuelva algo gana):
 *   1. Microlink   – extrae og:image de la página pública
 *   2. HTML directo – fetch + parseo og:image / twitter:image
 *   3. Unavatar.io  – proxy de avatares para LinkedIn (verificado contra placeholders)
 *
 * IMPORTANTE: Filtra placeholders genéricos (LinkedIn ghost, unavatar defaults).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Tamaño mínimo en bytes para considerar una imagen como foto real (no placeholder). */
const MIN_REAL_PHOTO_BYTES = 4_000;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function normalizeLinkedInProfileUrlForPhoto(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.endsWith("linkedin.com")) return null;
    if (!u.pathname.includes("/in/")) return null;
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/")) path += "/";
    return `https://www.linkedin.com${path}`;
  } catch {
    return null;
  }
}

/** Extrae el slug de vanidad del perfil: /in/{slug} */
function extractSlug(profileUrl: string): string | null {
  const m = profileUrl.match(/\/in\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function extractOgImage(html: string): string | null {
  const patterns: RegExp[] = [
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return null;
}

/**
 * Patrones de URLs que son placeholders genéricos (NO fotos reales de personas).
 * LinkedIn ghost person, LinkedIn share banners, unavatar defaults, etc.
 */
const PLACEHOLDER_PATTERNS = [
  /\/images\/share\//i,
  /\/sc\/h\//i,                    // LinkedIn Aero static icons (ghost person)
  /ghost/i,
  /default-avatar/i,
  /placeholder/i,
  /person-icon/i,
  /no-?photo/i,
  /anonymous/i,
  /\.svg$/i,                       // SVG icons are never real profile photos
  /static\.licdn\.com\/aero/i,     // LinkedIn Aero UI assets
  /static-exp\d?\.licdn\.com\/aero/i,
  /linkedin\.com\/images\//i,      // LinkedIn brand images
];

/** Descarta logos genéricos de share de LinkedIn y placeholders conocidos. */
export function looksLikeRealPersonPhoto(url: string): boolean {
  if (!url.startsWith("http")) return false;
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(url)) return false;
  }
  return true;
}

/* ── Estrategias de resolución ────────────────────────────────────────── */

async function tryMicrolink(profileUrl: string, timeoutMs: number): Promise<string | null> {
  const api = `https://api.microlink.io/?url=${encodeURIComponent(profileUrl)}`;
  const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { image?: { url?: string } } };
  const img = j?.data?.image?.url;
  if (typeof img !== "string" || !img.startsWith("http")) return null;
  return looksLikeRealPersonPhoto(img) ? img : null;
}

async function tryDirectHtml(profileUrl: string, timeoutMs: number): Promise<string | null> {
  const res = await fetch(profileUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const img = extractOgImage(html);
  if (!img || !img.startsWith("http")) return null;
  return looksLikeRealPersonPhoto(img) ? img : null;
}

/**
 * Intenta usar unavatar.io — sigue redirects, verifica la URL final y el tamaño.
 * Rechaza si:
 *  - La URL final es un placeholder conocido
 *  - La imagen pesa menos de MIN_REAL_PHOTO_BYTES (placeholder genérico)
 *  - No devuelve content-type image
 */
async function tryUnavatar(slug: string, timeoutMs: number): Promise<string | null> {
  const unavatarUrl = `https://unavatar.io/linkedin/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(unavatarUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("image")) return null;

    // Verificar la URL final (después de redirects)
    const finalUrl = res.url;
    if (!looksLikeRealPersonPhoto(finalUrl)) {
      console.log(`[photo] unavatar redirigió a placeholder: ${finalUrl}`);
      return null;
    }

    // Verificar tamaño — los placeholders suelen ser < 4KB
    const body = await res.arrayBuffer();
    if (body.byteLength < MIN_REAL_PHOTO_BYTES) {
      console.log(`[photo] unavatar devolvió imagen muy pequeña (${body.byteLength}B) para ${slug} — probablemente placeholder`);
      return null;
    }

    // Si la URL final es de media.licdn.com → foto real de LinkedIn CDN
    if (finalUrl.includes("media.licdn.com") || finalUrl.includes("licdn.com/dms/image")) {
      return finalUrl;
    }

    // Si la URL final es diferente de la URL de unavatar, usar la URL final (CDN directo)
    if (finalUrl !== unavatarUrl && finalUrl.startsWith("http")) {
      return looksLikeRealPersonPhoto(finalUrl) ? finalUrl : null;
    }

    // La imagen vino directamente de unavatar y es lo suficientemente grande → usar
    return unavatarUrl;
  } catch {
    return null;
  }
}

/**
 * Devuelve URL de foto de perfil REAL o null.
 * No consume cupo de visitas LinkedIn: usa solo APIs públicas.
 */
export async function resolveLinkedInProfilePhotoUrl(
  profileUrl: string,
  timeoutMs = 7000
): Promise<string | null> {
  const normalized = normalizeLinkedInProfileUrlForPhoto(profileUrl);
  if (!normalized) return null;
  const slug = extractSlug(normalized);

  // 1) Microlink
  try {
    const m = await tryMicrolink(normalized, Math.min(timeoutMs, 9000));
    if (m) {
      console.log(`[photo] Microlink resolvió foto para ${slug}: ${m.substring(0, 80)}…`);
      return m;
    }
  } catch {
    /* seguir */
  }

  // 2) HTML directo (og:image)
  try {
    const d = await tryDirectHtml(normalized, timeoutMs);
    if (d) {
      console.log(`[photo] HTML og:image resolvió foto para ${slug}: ${d.substring(0, 80)}…`);
      return d;
    }
  } catch {
    /* seguir */
  }

  // 3) Unavatar.io — verificando que NO sea placeholder
  if (slug) {
    const ua = await tryUnavatar(slug, 5000);
    if (ua) {
      console.log(`[photo] Unavatar resolvió foto para ${slug}: ${ua.substring(0, 80)}…`);
      return ua;
    }
  }

  console.log(`[photo] No se pudo resolver foto para ${slug ?? profileUrl}`);
  return null;
}

/* ── Resolver en lote (sync, para import Apify) ──────────────────────── */

export type BatchPhotoResult = { resolved: number; attempted: number };

/**
 * Resuelve fotos para una lista de leads de forma síncrona (bloquea hasta terminar).
 * No consume cupo de visitas LinkedIn.
 */
export async function resolveLeadPhotosBatch(
  leads: { id: string; profile_url: string }[],
  updateFn: (id: string, photoUrl: string) => Promise<void>,
  concurrency = 4,
  timeoutMs = 7000
): Promise<BatchPhotoResult> {
  let resolved = 0;
  for (let i = 0; i < leads.length; i += concurrency) {
    const chunk = leads.slice(i, i + concurrency);
    await Promise.allSettled(
      chunk.map(async (lead) => {
        const url = await resolveLinkedInProfilePhotoUrl(lead.profile_url, timeoutMs);
        if (url) {
          await updateFn(lead.id, url);
          resolved++;
        }
      })
    );
  }
  return { resolved, attempted: leads.length };
}
