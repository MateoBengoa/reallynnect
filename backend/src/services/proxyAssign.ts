import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto.js";

export async function pickProxyForAccount(
  sb: SupabaseClient,
  excludeId?: string
): Promise<string | null> {
  const { data, error } = await sb
    .from("proxies")
    .select("id,status,last_used")
    .eq("status", "active")
    .order("last_used", { ascending: true, nullsFirst: true })
    .limit(20);

  if (error || !data?.length) return null;

  const candidates = excludeId ? data.filter((p) => p.id !== excludeId) : data;
  const pick = candidates[0] ?? data[0];
  return pick?.id ?? null;
}

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
  const { data, error } = await sb.from("proxies").select("host,port,username,password").eq("id", proxyId).single();
  if (error || !data) return null;
  let password: string | null = data.password;
  if (password) {
    try {
      password = decryptSecret(password);
    } catch {
      password = data.password;
    }
  }
  return {
    host: data.host,
    port: data.port,
    username: data.username,
    password,
  };
}
