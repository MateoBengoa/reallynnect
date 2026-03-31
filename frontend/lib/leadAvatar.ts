import type { LeadRow } from "@/components/campaigns/leadTypes";

/** Extrae el slug /in/{slug} de una URL de perfil LinkedIn. */
export function linkedinVanityFromProfileUrl(url: string): string | null {
  const t = url?.trim();
  if (!t) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    if (!u.hostname.replace(/^www\./, "").includes("linkedin.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("in");
    if (i < 0 || !parts[i + 1]) return null;
    const slug = parts[i + 1]!;
    if (slug === "in" || slug.length < 2) return null;
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
}

/** Avatar vía unavatar (sin cookie); puede fallar para algunos perfiles. */
export function unavatarUrlForLinkedInProfile(profileUrl: string): string | null {
  const v = linkedinVanityFromProfileUrl(profileUrl);
  if (!v) return null;
  return `https://unavatar.io/linkedin/${encodeURIComponent(v)}`;
}

/**
 * URL a mostrar: solo foto guardada en DB (ya validada como real, no placeholder).
 * Si no hay foto guardada, devuelve null → se muestran las iniciales.
 */
export function displayAvatarUrlForLead(lead: LeadRow): string | null {
  const saved = lead.photo_url?.trim();
  if (saved) return saved;
  return null;
}

export function initialsFromLead(lead: LeadRow): string {
  const n = lead.name?.trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  const slug = lead.profile_url?.match(/\/in\/([^/?#]+)/)?.[1];
  if (slug && slug.length >= 2) return slug.slice(0, 2).toUpperCase();
  if (slug && slug.length === 1) return slug.toUpperCase();
  return "?";
}
