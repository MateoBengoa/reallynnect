import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { fetchWebshareProxies } from "./webshareService.js";

export async function markProxyUsed(sb: SupabaseClient, proxyId: string): Promise<void> {
  await sb.from("proxies").update({ last_used: new Date().toISOString() }).eq("id", proxyId);
}

export async function markProxyDegraded(sb: SupabaseClient, proxyId: string): Promise<void> {
  await sb.from("proxies").update({ status: "degraded" }).eq("id", proxyId);
}

export type ProxyRow = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export async function loadProxy(
  sb: SupabaseClient,
  proxyId: string
): Promise<ProxyRow | null> {
  const { data, error } = await sb
    .from("proxies")
    .select("host,port,username,password")
    .eq("id", proxyId)
    .single();
  if (error || !data) return null;
  let password: string | null = data.password;
  if (password) {
    try { password = decryptSecret(password); } catch { /* ya descifrada o plain */ }
  }
  return { host: data.host, port: data.port, username: data.username, password };
}

/**
 * Devuelve el proxy_id asignado a la cuenta. Si la cuenta no tiene uno asignado,
 * busca el primer proxy libre del usuario y lo asigna.
 * Devuelve null si el usuario no tiene proxies o todos están ocupados.
 */
export async function pickProxyForAccount(
  sb: SupabaseClient,
  userId: string,
  accountId: string,
  currentProxyId?: string | null
): Promise<string | null> {
  // Si ya tiene proxy asignado y está activo, usarlo
  if (currentProxyId) {
    const { data: existing } = await sb
      .from("proxies")
      .select("id,status")
      .eq("id", currentProxyId)
      .single();
    if (existing && existing.status === "active") return existing.id as string;
    // proxy degradado/inactivo — busca uno nuevo
  }

  // Busca un proxy del usuario sin cuenta asignada (libre)
  const { data: free } = await sb
    .from("proxies")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .is("account_id", null)
    .order("created_at", { ascending: true })
    .limit(1);

  const picked = free?.[0]?.id as string | undefined;
  if (!picked) return null;

  // Asignar el proxy a la cuenta (1:1)
  await sb.from("proxies").update({ account_id: accountId }).eq("id", picked);
  await sb.from("linkedin_accounts").update({ proxy_id: picked }).eq("id", accountId);
  return picked;
}

/**
 * Sincroniza los proxies de Webshare.io para un usuario.
 * Hace upsert por (user_id, webshare_proxy_id) — no duplica en re-syncs.
 * Devuelve cuántos se insertaron y cuántos ya existían.
 */
export async function syncWebshareProxies(
  sb: SupabaseClient,
  userId: string,
  apiKey: string
): Promise<{ inserted: number; updated: number; total: number }> {
  const proxies = await fetchWebshareProxies(apiKey);

  let inserted = 0;
  let updated = 0;

  for (const p of proxies) {
    if (!p.valid) continue;

    const passwordEncrypted = encryptSecret(p.password);

    const { data: existing } = await sb
      .from("proxies")
      .select("id")
      .eq("user_id", userId)
      .eq("webshare_proxy_id", p.id)
      .maybeSingle();

    if (existing) {
      // Actualizar credenciales (pueden cambiar en Webshare)
      await sb
        .from("proxies")
        .update({
          host: p.proxy_address,
          port: p.ports.http,
          username: p.username,
          password: passwordEncrypted,
          status: "active",
        })
        .eq("id", existing.id);
      updated++;
    } else {
      await sb.from("proxies").insert({
        user_id: userId,
        host: p.proxy_address,
        port: p.ports.http,
        username: p.username,
        password: passwordEncrypted,
        status: "active",
        webshare_proxy_id: p.id,
      });
      inserted++;
    }
  }

  return { inserted, updated, total: proxies.length };
}

/**
 * Auto-asigna proxies libres a cuentas del usuario que no tienen proxy.
 * Útil tras un sync de Webshare para emparejar automáticamente.
 */
export async function autoAssignProxiesToAccounts(
  sb: SupabaseClient,
  userId: string
): Promise<number> {
  const [{ data: accounts }, { data: freeProxies }] = await Promise.all([
    sb.from("linkedin_accounts").select("id").eq("user_id", userId).is("proxy_id", null),
    sb
      .from("proxies")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .is("account_id", null)
      .order("created_at", { ascending: true }),
  ]);

  const accountList = accounts ?? [];
  const proxyList = freeProxies ?? [];
  let assigned = 0;

  for (let i = 0; i < accountList.length && i < proxyList.length; i++) {
    const accountId = accountList[i]!.id as string;
    const proxyId = proxyList[i]!.id as string;
    await Promise.all([
      sb.from("proxies").update({ account_id: accountId }).eq("id", proxyId),
      sb.from("linkedin_accounts").update({ proxy_id: proxyId }).eq("id", accountId),
    ]);
    assigned++;
  }

  return assigned;
}
