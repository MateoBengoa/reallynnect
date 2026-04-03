"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Proxy = {
  id: string;
  host: string;
  port: number;
  username: string | null;
  status: string;
  last_used: string | null;
  account_id: string | null;
  webshare_proxy_id: string | null;
};

type Account = {
  id: string;
  li_display_name: string | null;
};

export default function ProxiesPage() {
  const [list, setList] = useState<Proxy[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Manual add form
  const [host, setHost] = useState("");
  const [port, setPort] = useState(3128);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [proxiesRes, accountsRes, keyRes] = await Promise.all([
      api<{ proxies: Proxy[] }>("/proxies"),
      api<{ accounts: Account[] }>("/linkedin-accounts"),
      api<{ has_key: boolean }>("/proxies/webshare-key"),
    ]);
    setList(proxiesRes.proxies);
    setAccounts(accountsRes.accounts);
    setHasKey(keyRes.has_key);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function syncWebshare() {
    setSyncMsg(null);
    setSyncing(true);
    try {
      if (!(await getValidAccessToken())) return;
      const r = await api<{ inserted: number; updated: number; total: number; assigned: number }>(
        "/proxies/sync-webshare",
        { method: "POST" }
      );
      setSyncMsg(
        `Sync completado: ${r.inserted} nuevos, ${r.updated} actualizados, ${r.assigned} asignados a cuentas (${r.total} proxies totales).`
      );
      await load();
    } catch (e2: unknown) {
      setSyncMsg(e2 instanceof Error ? e2.message : "Error al sincronizar");
    } finally {
      setSyncing(false);
    }
  }

  async function deleteProxy(id: string) {
    if (!(await getValidAccessToken())) return;
    try {
      await api(`/proxies/${id}`, { method: "DELETE" });
      await load();
    } catch { /* ignore */ }
  }

  async function assignProxy(proxyId: string, accountId: string | null) {
    if (!(await getValidAccessToken())) return;
    try {
      await api(`/proxies/${proxyId}/assign`, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId }),
      });
      await load();
    } catch { /* ignore */ }
  }

  async function addManual(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/proxies", {
        method: "POST",
        body: JSON.stringify({
          host,
          port,
          username: username || undefined,
          password: password || undefined,
        }),
      });
      setHost(""); setPassword(""); setUsername("");
      setShowManual(false);
      await load();
    } catch (e2: unknown) {
      setAddErr(e2 instanceof Error ? e2.message : "Error");
    }
  }

  const accountName = (id: string | null) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a?.li_display_name?.trim() || `…${id.slice(-6)}`;
  };

  const freeCount = list.filter((p) => !p.account_id && p.status === "active").length;
  const assignedCount = list.filter((p) => !!p.account_id).length;

  return (
    <div>
      <h1 className="page-title mb-1">Proxies</h1>
      <p className="page-desc mb-6">
        Cada cuenta LinkedIn funciona con su propio proxy residencial estático dedicado (1:1).
        Los proxies se sincronizan desde Webshare.io y se asignan automáticamente.
      </p>

      {/* Webshare sync */}
      <section className="card card-pad mb-6 max-w-xl space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[var(--text)]">Sincronizar con Webshare.io</p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            hasKey
              ? "bg-green-500/10 text-green-400"
              : "bg-amber-500/10 text-amber-400"
          }`}>
            {hasKey ? "API key configurada" : "Sin API key en servidor"}
          </span>
        </div>

        <button
          type="button"
          disabled={syncing || !hasKey}
          onClick={syncWebshare}
          className="btn-primary w-full disabled:opacity-50"
        >
          {syncing ? "Sincronizando…" : "Sync desde Webshare"}
        </button>

        {!hasKey && (
          <p className="text-xs text-amber-400">
            Añade <code className="font-mono">WEBSHARE_API_KEY=tu_key</code> al <code>.env</code> del servidor y reinicia.
          </p>
        )}

        {syncMsg && (
          <p className={`text-sm ${syncMsg.startsWith("Sync") ? "text-green-400" : "text-red-400"}`}>
            {syncMsg}
          </p>
        )}
      </section>

      {/* Stats */}
      {list.length > 0 && (
        <div className="mb-4 flex gap-4 text-sm text-[var(--muted)]">
          <span>{list.length} proxies totales</span>
          <span className="text-green-400">{assignedCount} asignados</span>
          <span>{freeCount} libres</span>
        </div>
      )}

      {/* Proxy list */}
      {list.length > 0 && (
        <ul className="mb-6 space-y-2">
          {list.map((p) => {
            const assignedName = accountName(p.account_id);
            return (
              <li
                key={p.id}
                className="card card-pad flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-mono text-sm text-[var(--text)]">
                    {p.host}:{p.port}
                  </span>
                  {p.username && (
                    <span className="text-xs text-[var(--muted)]">{p.username}</span>
                  )}
                  {p.webshare_proxy_id && (
                    <span className="font-mono text-[10px] text-[color-mix(in_srgb,var(--text)_30%,var(--surface))]">
                      webshare:{p.webshare_proxy_id.slice(0, 12)}…
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    p.status === "active"
                      ? "bg-green-500/10 text-green-400"
                      : "bg-amber-500/10 text-amber-400"
                  }`}>
                    {p.status}
                  </span>

                  <select
                    className="input-field h-8 py-0 text-xs"
                    value={p.account_id ?? ""}
                    onChange={(e) => assignProxy(p.id, e.target.value || null)}
                  >
                    <option value="">— libre —</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.li_display_name?.trim() || `…${a.id.slice(-6)}`}
                      </option>
                    ))}
                  </select>

                  {assignedName && (
                    <span className="hidden text-xs text-[var(--muted)] sm:block">→ {assignedName}</span>
                  )}

                  <button
                    type="button"
                    className="btn-danger px-2 py-1 text-xs"
                    onClick={() => deleteProxy(p.id)}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {list.length === 0 && (
        <div className="mb-6 rounded-xl border border-dashed border-[var(--border)] py-10 text-center text-sm text-[var(--muted)]">
          Sin proxies. Haz sync desde Webshare o añade uno manualmente.
        </div>
      )}

      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() => setShowManual((v) => !v)}
      >
        {showManual ? "Ocultar" : "Añadir proxy manual"}
      </button>

      {showManual && (
        <form onSubmit={addManual} className="card card-pad mt-4 grid max-w-lg gap-3 sm:grid-cols-2">
          <input
            className="input-field sm:col-span-2"
            placeholder="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
          />
          <input
            type="number"
            className="input-field"
            placeholder="Puerto"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
          <input
            className="input-field"
            placeholder="Usuario (opcional)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            className="input-field sm:col-span-2"
            placeholder="Contraseña proxy"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {addErr && <p className="text-sm text-red-400 sm:col-span-2">{addErr}</p>}
          <button type="submit" className="btn-primary sm:col-span-2">
            Añadir proxy
          </button>
        </form>
      )}
    </div>
  );
}
