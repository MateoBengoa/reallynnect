import { createClient } from "@supabase/supabase-js";

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "anon-placeholder";

export const supabase = createClient(url, anon);

/**
 * Token JWT para el backend. Renueva la sesión si está a punto de caducar o ya caducó
 * (`getSession()` solo lee caché local y puede devolver un access_token inválido para la API).
 */
export async function getValidAccessToken(): Promise<string | null> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  if (error || !session?.access_token) return null;
  const expMs = (session.expires_at ?? 0) * 1000;
  const marginMs = 120_000;
  const expiredOrSoon = expMs < Date.now() + marginMs;
  if (expiredOrSoon) {
    const { data, error: refErr } = await supabase.auth.refreshSession();
    if (!refErr && data.session?.access_token) return data.session.access_token;
    if (expMs < Date.now()) return null;
  }
  return session.access_token;
}
