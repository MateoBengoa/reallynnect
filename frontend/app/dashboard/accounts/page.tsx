"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Account = {
  id: string;
  connection_status: string;
  softban_status: string;
  paused_until: string | null;
  last_warmup_at: string | null;
  li_display_name: string | null;
  li_headline: string | null;
  li_photo_url: string | null;
  session_verified_at: string | null;
  daily_message_budget: number | null;
  daily_visit_budget: number | null;
  daily_connect_budget: number | null;
  rotation_priority: number;
  proxy_id: string | null;
};

type ProxyDraft = {
  host: string;
  port: string;
  username: string;
  password: string;
};

function verificationLabel(a: Account): string {
  if (a.connection_status === "pending") {
    return "Verificación en curso: el worker está comprobando la cookie en LinkedIn…";
  }
  if (a.session_verified_at) {
    const when = new Date(a.session_verified_at).toLocaleString("es", {
      dateStyle: "short",
      timeStyle: "short",
    });
    if (a.connection_status === "active") {
      return `Perfil sincronizado el ${when}.`;
    }
    if (a.connection_status === "error") {
      return `Última comprobación el ${when} (sesión no válida). Revisa la cookie o vuelve a conectar.`;
    }
    return `Última sincronización: ${when}`;
  }
  if (a.connection_status === "active") {
    if (!a.li_display_name) {
      return "Sesión activa. Pulsa «Sincronizar perfil» para traer nombre, puesto y foto desde LinkedIn.";
    }
    return "Sesión activa.";
  }
  if (a.connection_status === "error") {
    return "Error de conexión. Vuelve a pegar un li_at válido.";
  }
  return a.connection_status;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [liAt, setLiAt] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, ProxyDraft>>({});
  const [proxyOpen, setProxyOpen] = useState<string | null>(null);
  const syncBaseline = useRef<{ at: string | null; name: string | null } | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ accounts: Account[] }>("/linkedin-accounts");
    setAccounts(r.accounts);
    const next: Record<string, string> = {};
    for (const a of r.accounts) {
      next[`${a.id}-msg`] = a.daily_message_budget != null ? String(a.daily_message_budget) : "";
      next[`${a.id}-vis`] = a.daily_visit_budget != null ? String(a.daily_visit_budget) : "";
      next[`${a.id}-con`] = a.daily_connect_budget != null ? String(a.daily_connect_budget) : "";
      next[`${a.id}-rot`] = String(a.rotation_priority ?? 0);
    }
    setBudgetDrafts(next);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const needPoll =
    accounts.some((a) => a.connection_status === "pending") || syncingId !== null;

  useEffect(() => {
    if (!needPoll) return;
    const id = setInterval(() => load(), 4000);
    return () => clearInterval(id);
  }, [needPoll, load]);

  useEffect(() => {
    if (!syncingId || !syncBaseline.current) return;
    const a = accounts.find((x) => x.id === syncingId);
    if (!a) return;
    const b = syncBaseline.current;
    const verifiedChanged = (a.session_verified_at ?? null) !== (b.at ?? null);
    const nameAppeared = !b.name && !!a.li_display_name?.trim();
    if (verifiedChanged || nameAppeared) {
      setSyncingId(null);
      syncBaseline.current = null;
    }
  }, [accounts, syncingId]);

  useEffect(() => {
    if (!syncingId) return;
    const t = setTimeout(() => {
      setSyncingId(null);
      syncBaseline.current = null;
    }, 120_000);
    return () => clearTimeout(t);
  }, [syncingId]);

  async function syncProfile(accountId: string) {
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    const acc = accounts.find((x) => x.id === accountId);
    syncBaseline.current = {
      at: acc?.session_verified_at ?? null,
      name: acc?.li_display_name ?? null,
    };
    setSyncingId(accountId);
    try {
      await api<{ ok: boolean }>(`/linkedin-accounts/${accountId}/sync-profile`, {
        method: "POST",
      });
      setMsg("Sincronización en cola. En unos segundos deberían aparecer nombre, puesto y foto.");
      await load();
    } catch (e: unknown) {
      setSyncingId(null);
      syncBaseline.current = null;
      setMsg(e instanceof Error ? e.message : "Error al sincronizar");
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api<{ id: string; verify_task_id: string | null }>("/linkedin-accounts", {
        method: "POST",
        body: JSON.stringify({ li_at: liAt.trim() }),
      });
      setMsg(
        "Cuenta guardada. El worker verificará la sesión y podrás usar «Sincronizar perfil» si faltan datos."
      );
      setLiAt("");
      await load();
    } catch (e2: unknown) {
      setMsg(e2 instanceof Error ? e2.message : "Error");
    }
  }

  async function remove(id: string) {
    const acc = accounts.find((a) => a.id === id);
    const label = acc?.li_display_name ?? id.slice(0, 8);
    if (!window.confirm(`¿Eliminar la cuenta "${label}"? Esta acción no se puede deshacer.`)) return;
    if (!(await getValidAccessToken())) return;
    try {
      await api(`/linkedin-accounts/${id}`, { method: "DELETE" });
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Error al eliminar la cuenta");
    }
  }

  function numOrNull(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function saveOwnProxy(accountId: string) {
    const d = proxyDrafts[accountId];
    if (!d?.host || !d?.port) return;
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    try {
      // Crear proxy nuevo y asignarlo a la cuenta
      const proxy = await api<{ id: string }>("/proxies", {
        method: "POST",
        body: JSON.stringify({
          host: d.host.trim(),
          port: parseInt(d.port, 10),
          username: d.username.trim() || undefined,
          password: d.password.trim() || undefined,
        }),
      });
      await api(`/linkedin-accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ proxy_id: proxy.id }),
      });
      setMsg("Proxy propio guardado y asignado.");
      setProxyOpen(null);
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Error al guardar proxy");
    }
  }

  async function removeProxy(accountId: string) {
    if (!(await getValidAccessToken())) return;
    try {
      await api(`/linkedin-accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ proxy_id: null }),
      });
      await load();
    } catch {
      /* ignore */
    }
  }

  async function saveBudgets(accountId: string) {
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api(`/linkedin-accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({
          daily_message_budget: numOrNull(budgetDrafts[`${accountId}-msg`] ?? ""),
          daily_visit_budget: numOrNull(budgetDrafts[`${accountId}-vis`] ?? ""),
          daily_connect_budget: numOrNull(budgetDrafts[`${accountId}-con`] ?? ""),
          rotation_priority: Math.floor(Number(budgetDrafts[`${accountId}-rot`] ?? "0")) || 0,
        }),
      });
      setMsg("Límites guardados. Vacío = límite por defecto del worker.");
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Error");
    }
  }

  return (
    <div>
      <h1 className="page-title mb-4">Cuentas LinkedIn</h1>
      <p className="page-desc mb-4">
        Inicia sesión en LinkedIn, abre DevTools → Application → Cookies → copia el valor de{" "}
        <code className="text-[var(--text)]">li_at</code> y pégalo aquí. Se cifra antes de guardarse. Los presupuestos diarios
        (DM, visitas, invitaciones) y la prioridad de rotación aplican a campañas y límites Redis por cuenta.
      </p>
      <form onSubmit={connect} className="card card-pad mb-8 max-w-xl space-y-3">
        <textarea
          className="input-field min-h-[100px] py-2 font-mono text-xs"
          placeholder="Pegar li_at…"
          value={liAt}
          onChange={(e) => setLiAt(e.target.value)}
          required
        />
        {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}
        <button type="submit" className="btn-primary">
          Guardar y verificar sesión
        </button>
      </form>
      <ul className="space-y-3">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="card card-pad flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex min-w-0 flex-1 gap-3">
              {a.li_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.li_photo_url}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-[var(--border)]"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))] text-lg text-[var(--muted)]">
                  in
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-medium text-[var(--text)]">
                  {a.li_display_name?.trim() || "Sin nombre (pulsa sincronizar)"}
                </p>
                {a.li_headline && (
                  <p className="mt-0.5 line-clamp-2 text-sm text-[var(--muted)]">{a.li_headline}</p>
                )}
                <p className="mt-2 text-xs text-[var(--muted)]">{verificationLabel(a)}</p>
                <p className="mt-1 font-mono text-[10px] text-[color-mix(in_srgb,var(--text)_35%,var(--muted))]">{a.id}</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:max-w-md">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Límites diarios (opcional)</p>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[var(--muted)]">DM</span>
                  <input
                    className="input-field min-h-9 py-1.5 text-xs"
                    inputMode="numeric"
                    value={budgetDrafts[`${a.id}-msg`] ?? ""}
                    onChange={(e) => setBudgetDrafts((d) => ({ ...d, [`${a.id}-msg`]: e.target.value }))}
                    placeholder="auto"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[var(--muted)]">Visitas</span>
                  <input
                    className="input-field min-h-9 py-1.5 text-xs"
                    inputMode="numeric"
                    value={budgetDrafts[`${a.id}-vis`] ?? ""}
                    onChange={(e) => setBudgetDrafts((d) => ({ ...d, [`${a.id}-vis`]: e.target.value }))}
                    placeholder="auto"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[var(--muted)]">Conexiones</span>
                  <input
                    className="input-field min-h-9 py-1.5 text-xs"
                    inputMode="numeric"
                    value={budgetDrafts[`${a.id}-con`] ?? ""}
                    onChange={(e) => setBudgetDrafts((d) => ({ ...d, [`${a.id}-con`]: e.target.value }))}
                    placeholder="auto"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[var(--muted)]">Prioridad</span>
                  <input
                    className="input-field min-h-9 py-1.5 text-xs"
                    inputMode="numeric"
                    value={budgetDrafts[`${a.id}-rot`] ?? "0"}
                    onChange={(e) => setBudgetDrafts((d) => ({ ...d, [`${a.id}-rot`]: e.target.value }))}
                    title="Menor = primera cuenta elegida en campañas activas"
                  />
                </label>
              </div>
              <button type="button" className="btn-secondary min-h-9 self-start px-3 py-1 text-xs" onClick={() => saveBudgets(a.id)}>
                Guardar límites
              </button>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-col">
              <button
                type="button"
                disabled={a.connection_status === "pending" || syncingId === a.id}
                className="btn-secondary disabled:opacity-40"
                onClick={() => syncProfile(a.id)}
              >
                {syncingId === a.id ? "Sincronizando…" : "Sincronizar perfil"}
              </button>
              <span className="rounded-[var(--radius-sm)] bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))] px-2 py-0.5 text-xs text-[var(--muted)]">
                {a.connection_status}
                {a.connection_status === "pending" ? " · …" : ""} · {a.softban_status}
              </span>
              {a.proxy_id ? (
                <div className="flex items-center gap-1">
                  <span className="rounded-[var(--radius-sm)] bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                    proxy ✓
                  </span>
                  <button
                    type="button"
                    className="text-[10px] text-[var(--muted)] hover:text-red-400"
                    onClick={() => removeProxy(a.id)}
                    title="Quitar proxy (se usará el de la app)"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400 hover:bg-amber-500/20"
                  onClick={() => setProxyOpen(proxyOpen === a.id ? null : a.id)}
                >
                  {proxyOpen === a.id ? "cancelar" : "sin proxy · conectar el mío"}
                </button>
              )}
              {proxyOpen === a.id && (
                <div className="w-full rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))] p-3 text-xs">
                  <p className="mb-2 text-[var(--muted)]">Proxy propio (deja vacío usuario/contraseña si no tiene)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="input-field col-span-2 py-1.5 text-xs"
                      placeholder="Host (ej: 1.2.3.4 o proxy.host.com)"
                      value={proxyDrafts[a.id]?.host ?? ""}
                      onChange={(e) => setProxyDrafts((d) => ({ ...d, [a.id]: { ...d[a.id] ?? { host:"",port:"",username:"",password:"" }, host: e.target.value } }))}
                    />
                    <input
                      className="input-field py-1.5 text-xs"
                      placeholder="Puerto"
                      inputMode="numeric"
                      value={proxyDrafts[a.id]?.port ?? ""}
                      onChange={(e) => setProxyDrafts((d) => ({ ...d, [a.id]: { ...d[a.id] ?? { host:"",port:"",username:"",password:"" }, port: e.target.value } }))}
                    />
                    <input
                      className="input-field py-1.5 text-xs"
                      placeholder="Usuario (opcional)"
                      value={proxyDrafts[a.id]?.username ?? ""}
                      onChange={(e) => setProxyDrafts((d) => ({ ...d, [a.id]: { ...d[a.id] ?? { host:"",port:"",username:"",password:"" }, username: e.target.value } }))}
                    />
                    <input
                      type="password"
                      className="input-field col-span-2 py-1.5 text-xs"
                      placeholder="Contraseña (opcional)"
                      value={proxyDrafts[a.id]?.password ?? ""}
                      onChange={(e) => setProxyDrafts((d) => ({ ...d, [a.id]: { ...d[a.id] ?? { host:"",port:"",username:"",password:"" }, password: e.target.value } }))}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-primary mt-2 py-1.5 text-xs"
                    onClick={() => saveOwnProxy(a.id)}
                  >
                    Guardar proxy propio
                  </button>
                </div>
              )}
              <button type="button" className="btn-danger w-full sm:w-auto" onClick={() => remove(a.id)}>
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
