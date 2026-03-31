/**
 * Ejecuta el actor de Apify pipelinelabs~lead-scraper-apollo-zoominfo-lusha-ppe (PPE) u otro
 * vía REST y devuelve ítems del dataset. Documentación: https://docs.apify.com/api/v2/act-runs-post
 */

const APIFY_API = "https://api.apify.com/v2";

/** ID del actor en consola Apify (equiv. a harvestapi/linkedin-profile-search). */
export const DEFAULT_LEAD_ACTOR_ID = "M2FMdjRVeF1HPGFcc";

export type ApifyRunActorOptions = {
  token: string;
  actorId: string;
  input: Record<string, unknown>;
  maxWaitMs: number;
  pollMs?: number;
};

type ApifyRunResponse = {
  data?: {
    id: string;
    status: string;
    statusMessage?: string | null;
    defaultDatasetId?: string | null;
  };
  error?: { message?: string };
};

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export async function startActorRun(
  token: string,
  actorId: string,
  input: Record<string, unknown>
): Promise<string> {
  const url = `${APIFY_API}/acts/${encodeURIComponent(actorId)}/runs`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as ApifyRunResponse;
  if (!res.ok) {
    const msg = body.error?.message ?? res.statusText;
    throw new Error(`Apify start run failed (${res.status}): ${msg}`);
  }
  const id = body.data?.id;
  if (!id) throw new Error("Apify: respuesta sin run id");
  return id;
}

export async function waitForActorRun(
  token: string,
  runId: string,
  maxWaitMs: number,
  pollMs = 10_000
): Promise<{ defaultDatasetId: string }> {
  const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${APIFY_API}/actor-runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders(token),
    });
    const body = (await res.json()) as ApifyRunResponse;
    if (!res.ok) {
      throw new Error(`Apify poll run failed (${res.status}): ${body.error?.message ?? res.statusText}`);
    }
    const data = body.data;
    if (!data) throw new Error("Apify: run sin data");
    if (terminal.has(data.status)) {
      if (data.status !== "SUCCEEDED") {
        throw new Error(
          `Apify run ${data.status}${data.statusMessage ? `: ${data.statusMessage}` : ""}`
        );
      }
      const ds = data.defaultDatasetId;
      if (!ds) throw new Error("Apify: run OK sin defaultDatasetId");
      return { defaultDatasetId: ds };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Apify: timeout esperando run (${Math.round(maxWaitMs / 1000)}s)`);
}

export async function fetchDatasetItems(token: string, datasetId: string): Promise<unknown[]> {
  const pageSize = 1000;
  const all: unknown[] = [];
  let offset = 0;
  for (;;) {
    const url = new URL(`${APIFY_API}/datasets/${encodeURIComponent(datasetId)}/items`);
    url.searchParams.set("format", "json");
    url.searchParams.set("clean", "1");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url.toString(), { headers: authHeaders(token) });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Apify dataset read ${res.status}: ${err.slice(0, 200)}`);
    }
    const batch = (await res.json()) as unknown[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export async function runLeadActorAndFetchItems(opts: ApifyRunActorOptions): Promise<unknown[]> {
  const runId = await startActorRun(opts.token, opts.actorId, opts.input);
  console.log(`[apify_lead_finder] run started id=${runId} actor=${opts.actorId}`);
  const { defaultDatasetId } = await waitForActorRun(
    opts.token,
    runId,
    opts.maxWaitMs,
    opts.pollMs ?? 10_000
  );
  const items = await fetchDatasetItems(opts.token, defaultDatasetId);
  console.log(`[apify_lead_finder] run=${runId} dataset items=${items.length}`);
  return items;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function normalizeLinkedInProfileUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.endsWith("linkedin.com")) return null;
    let path = u.pathname.replace(/\/$/, "");
    if (!path.includes("/in/")) return null;
    path = path.split("?")[0] ?? path;
    return `https://www.linkedin.com${path}`;
  } catch {
    const m = t.match(/linkedin\.com\/in\/[^?\s#"']+/i);
    if (!m) return null;
    return `https://www.${m[0].replace(/^\/+/, "")}`;
  }
}

function deepCollectStrings(val: unknown, out: string[], depth: number): void {
  if (depth > 6) return;
  if (typeof val === "string") {
    if (val.trim()) out.push(val);
    return;
  }
  if (Array.isArray(val)) {
    for (const x of val) deepCollectStrings(x, out, depth + 1);
    return;
  }
  if (val && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) deepCollectStrings(v, out, depth + 1);
  }
}

function firstLinkedInUrl(obj: Record<string, unknown>): string | null {
  const keys = [
    "linkedinUrl",
    "linkedin_url",
    "linkedInUrl",
    "personLinkedinUrl",
    "personLinkedInUrl",
    "person_linkedin_url",
    "linkedinProfileUrl",
    "linkedin_profile_url",
    "personLinkedin",
    "LinkedIn URL",
    "LinkedIn",
    "linkedin",
    "profileUrl",
    "profile_url",
    "url",
  ];
  for (const k of keys) {
    const raw = str(obj[k]);
    if (!raw) continue;
    const norm = normalizeLinkedInProfileUrl(raw);
    if (norm) return norm;
  }

  const nestedKeys = ["person", "contact", "data", "profile", "lead", "prospect"];
  for (const nk of nestedKeys) {
    const inner = obj[nk];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const found = firstLinkedInUrl(inner as Record<string, unknown>);
      if (found) return found;
    }
  }

  const strings: string[] = [];
  deepCollectStrings(obj, strings, 0);
  for (const s of strings) {
    const norm = normalizeLinkedInProfileUrl(s);
    if (norm) return norm;
  }
  return null;
}

function scalarOrFirst(v: unknown): string | null {
  if (Array.isArray(v) && v.length) return str(v[0]);
  return str(v);
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = scalarOrFirst(obj[k]);
    if (v) return v;
  }
  return null;
}

function companyFromRecord(o: Record<string, unknown>): string | null {
  const flat = pickStr(o, [
    "orgName",
    "organizationName",
    "organization_name",
    "company",
    "companyName",
    "company_name",
    "Company",
    "organization",
  ]);
  if (flat) return flat;
  for (const ck of ["company", "organization", "employer", "org"]) {
    const co = o[ck];
    if (co && typeof co === "object" && !Array.isArray(co)) {
      const n = pickStr(co as Record<string, unknown>, ["name", "companyName", "company_name", "title", "domain"]);
      if (n) return n;
    }
  }
  return null;
}

function buildLocation(obj: Record<string, unknown>): string | null {
  const city = pickStr(obj, ["city", "personCity", "person_city", "locationCity", "City"]);
  const state = pickStr(obj, ["state", "personState", "person_state", "locationState", "State"]);
  const country = pickStr(obj, ["country", "personCountry", "person_country", "locationCountry", "Country"]);
  const loc = pickStr(obj, ["location", "Location", "geo", "formattedLocation", "formatted_location"]);
  if (loc && !city && !state && !country) return loc;
  const parts = [city, state, country].filter(Boolean);
  return parts.length ? parts.join(", ") : loc;
}

/** Mapea un ítem del dataset Pipeline Labs (y variantes) a fila `leads`. */
export function mapApifyItemToLeadInsert(item: unknown): {
  profile_url: string;
  name?: string | null;
  company?: string | null;
  title?: string | null;
  headline?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  website?: string | null;
  photo_url?: string | null;
  notes?: string | null;
  source?: string;
} | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const profile_url = firstLinkedInUrl(o);
  if (!profile_url) return null;

  const merged: Record<string, unknown> = { ...o };
  for (const nk of ["person", "contact", "data", "profile", "lead"]) {
    const inner = o[nk];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      Object.assign(merged, inner as Record<string, unknown>);
    }
  }

  const fromParts = [
    pickStr(merged, ["firstName", "first_name", "givenName", "First Name"]),
    pickStr(merged, ["lastName", "last_name", "familyName", "Last Name"]),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  const name =
    pickStr(merged, ["fullName", "full_name", "name", "personName", "person_name", "Full Name", "Name"]) ??
    (fromParts || null);

  // Intentar extraer de las recolecciones complejas de harvestapi
  let harvestCompany: string | null = null;
  let harvestTitle: string | null = null;
  const currPosInfo = Array.isArray(o.currentPosition) ? o.currentPosition[0] : null;
  const expInfo = Array.isArray(o.experience) ? o.experience[0] : null;
  
  if (currPosInfo && typeof currPosInfo === "object") {
    harvestCompany = (currPosInfo as any).companyName || null;
    harvestTitle = (currPosInfo as any).title || null;
  }
  if (!harvestCompany && expInfo && typeof expInfo === "object") {
    harvestCompany = (expInfo as any).companyName || null;
  }
  if (!harvestTitle && expInfo && typeof expInfo === "object") {
    harvestTitle = (expInfo as any).position || (expInfo as any).title || null;
  }

  const title = harvestTitle ?? pickStr(merged, [
    "position",
    "title",
    "jobTitle",
    "job_title",
    "personTitle",
    "headline",
    "Headline",
    "Title",
  ]);
  const headline = pickStr(merged, ["headline", "Headline"]) ?? title;
  const company = harvestCompany ?? companyFromRecord(merged) ?? companyFromRecord(o);
  
  const email = pickStr(merged, ["email", "workEmail", "work_email", "Email"]);
  const phone = pickStr(merged, ["phone", "mobile", "phoneNumber", "phone_number", "Mobile"]);
  const website = pickStr(merged, ["orgWebsite", "companyWebsite", "company_website", "website", "domain", "companyDomain"]);
  
  let harvestLocation: string | null = null;
  if (o.location && typeof o.location === "object" && !Array.isArray(o.location)) {
    harvestLocation = (o.location as any).linkedinText || (o.location as any).parsed?.text || null;
  }
  const location = harvestLocation ?? buildLocation(merged);

  const rawPhoto = o.profilePicture as any;
  const explicitPhoto = rawPhoto?.url || o.photo || o.personPhotoUrl || null;
  
  const photo_url = explicitPhoto ?? pickStr(merged, [
    "photoUrl",
    "photo_url",
    "imageUrl",
    "image_url",
    "pictureUrl",
    "picture_url",
    "avatar",
    "avatarUrl",
    "avatar_url",
    "profileImageUrl",
    "profile_image_url",
    "profilePictureUrl",
    "profile_picture_url",
    "linkedinProfilePicture",
    "linkedin_profile_picture",
    "LinkedIn Photo",
    "thumbnailUrl",
    "thumbnail_url",
    "profilePicture",
    "personPhotoUrl",
    "person_photo_url",
    "personImageUrl",
    "person_image_url",
    "headshot",
    "headshotUrl",
    "headshot_url",
    "profilePhoto",
    "profile_photo",
    "profilePhotoUrl",
    "profile_photo_url",
    "Photo",
    "photo",
    "Image",
    "image",
    "Picture",
    "picture",
  ]);

  const rawNodes: Record<string, string | number | boolean> = {};
  if (o.connectionsCount !== undefined) rawNodes.Conexiones = o.connectionsCount as number;
  if (o.followerCount !== undefined) rawNodes.Seguidores = o.followerCount as number;
  if (o.premium) rawNodes.Premium = "Sí";
  if (o.openToWork) rawNodes["Open to Work"] = "Sí";
  if (o.verified) rawNodes.Verificado = "Sí";
  
  const notes = Object.keys(rawNodes).length > 0 ? JSON.stringify(rawNodes) : null;

  return {
    profile_url,
    name,
    company,
    title,
    headline,
    email,
    phone,
    location,
    website,
    photo_url,
    notes,
    source: "apify:harvestapi-linkedin-profile-search",
  };
}
