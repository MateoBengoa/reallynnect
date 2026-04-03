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
 * Devuelve el proxy_id asignado a la cuenta. Si no tiene uno, asigna automáticamente:
 * 1. Primero busca en el pool global de la app (user_id IS NULL)
 * 2. Si no hay, busca en los proxies propios del usuario
 * Devuelve null si no hay proxies libres disponibles.
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

  // 1. Buscar proxy libre del pool de la app (user_id IS NULL)
  const { data: appFree } = await sb
    .from("proxies")
    .select("id")
    .is("user_id", null)
    .eq("status", "active")
    .is("account_id", null)
    .order("created_at", { ascending: true })
    .limit(1);

  // 2. Si no hay en el pool de la app, buscar proxy propio del usuario
  const { data: userFree } = !appFree?.[0]
    ? await sb
        .from("proxies")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "active")
        .is("account_id", null)
        .order("created_at", { ascending: true })
        .limit(1)
    : { data: null };

  const picked = (appFree?.[0]?.id ?? userFree?.[0]?.id) as string | undefined;
  if (!picked) return null;

  // Asignar el proxy a la cuenta (1:1)
  await sb.from("proxies").update({ account_id: accountId }).eq("id", picked);
  await sb.from("linkedin_accounts").update({ proxy_id: picked }).eq("id", accountId);
  return picked;
}

/**
 * Sincroniza los proxies de Webshare.io.
 * userId = null → proxies del pool de la app (sin dueño, asignables a cualquier cuenta)
 * userId = string → proxies propios de un usuario
 * Hace upsert por webshare_proxy_id — no duplica en re-syncs.
 */
export async function syncWebshareProxies(
  sb: SupabaseClient,
  userId: string | null,
  apiKey: string
): Promise<{ inserted: number; updated: number; total: number }> {
  const proxies = await fetchWebshareProxies(apiKey);

  let inserted = 0;
  let updated = 0;

  for (const p of proxies) {
    if (!p.valid) continue;

    const passwordEncrypted = encryptSecret(p.password);

    const query = sb
      .from("proxies")
      .select("id")
      .eq("webshare_proxy_id", p.id);

    const { data: existing } = await (userId ? query.eq("user_id", userId) : query.is("user_id", null)).maybeSingle();

    if (existing) {
      await sb
        .from("proxies")
        .update({
          host: p.proxy_address,
          port: p.port,
          username: p.username,
          password: passwordEncrypted,
          status: "active",
        })
        .eq("id", existing.id);
      updated++;
    } else {
      await sb.from("proxies").insert({
        user_id: userId ?? null,
        host: p.proxy_address,
        port: p.port,
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
  // Cuentas sin proxy del usuario
  const { data: accounts } = await sb
    .from("linkedin_accounts")
    .select("id")
    .eq("user_id", userId)
    .is("proxy_id", null);

  // Proxies libres: primero del pool de la app (user_id NULL), luego propios del usuario
  const { data: appProxies } = await sb
    .from("proxies")
    .select("id")
    .is("user_id", null)
    .eq("status", "active")
    .is("account_id", null)
    .order("created_at", { ascending: true });

  const { data: userProxies } = await sb
    .from("proxies")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .is("account_id", null)
    .order("created_at", { ascending: true });

  const freeProxies = [...(appProxies ?? []), ...(userProxies ?? [])];

  const accountList = accounts ?? [];
  const proxyList = freeProxies;
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
