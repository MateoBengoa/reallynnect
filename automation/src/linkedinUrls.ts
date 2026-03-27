/** Convierte entradas de leads (URL parcial, vanity, etc.) en URL de perfil estable. */
export function normalizeLinkedInProfileUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;

  const withHost = (path: string) => {
    const p = path.startsWith("/") ? path : `/${path}`;
    return `https://www.linkedin.com${p.replace(/\/+$/, "") || "/"}`;
  };

  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = u.hostname.toLowerCase();
      if (!h.endsWith("linkedin.com")) return s;
      if (h === "linkedin.com" || h === "m.linkedin.com" || h === "mobile.linkedin.com") {
        u.hostname = "www.linkedin.com";
      }
      return u.toString();
    }
    if (s.startsWith("/") && /linkedin\.com/i.test(s)) {
      const idx = s.toLowerCase().indexOf("linkedin.com");
      const path = s.slice(idx + "linkedin.com".length) || "/";
      return withHost(path);
    }
    if (s.startsWith("/")) return withHost(s);
    if (/^in\/[\w-]+/i.test(s)) return withHost(`/${s}`);
    if (/linkedin\.com\/in\//i.test(s)) return normalizeLinkedInProfileUrl(`https://${s.replace(/^\/+/, "")}`);
    return withHost(`/in/${s.replace(/^\/+/, "")}`);
  } catch {
    return s;
  }
}
