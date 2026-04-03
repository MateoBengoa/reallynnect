"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Profile = {
  id: string;
  email: string | null;
  webhook_url: string | null;
  webhook_events: string[] | null;
};

type LinkedAccount = {
  id: string;
  connection_status: string;
  li_display_name: string | null;
  proxy_id: string | null;
};

type ProxyRow = {
  id: string;
  host: string;
  port: number;
  account_id: string | null;
};


const sectionTitle = "mb-1 text-lg font-semibold tracking-tight text-[var(--text)]";
const sectionDesc = "mb-4 text-sm text-[var(--muted)]";

function NewAccountForm({ onAdded, setMsg }: { onAdded: () => void; setMsg: (m: string) => void }) {
  const [liAt, setLiAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    setSaving(true);
    try {
      await api("/linkedin-accounts", {
        method: "POST",
        body: JSON.stringify({ li_at: liAt.trim() }),
      });
      setLiAt("");
      setMsg("Cuenta guardada. El worker verificará la sesión en unos segundos.");
      onAdded();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : "Error al guardar la cuenta");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="card card-pad space-y-3">
      <p className="text-sm font-medium text-[var(--text)]">Conectar nueva cuenta</p>
      <textarea
        className="input-field min-h-[100px] py-2 font-mono text-xs"
        placeholder="Pegar li_at aquí…"
        value={liAt}
        onChange={(e) => setLiAt(e.target.value)}
        required
        autoComplete="off"
      />
      <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50">
        {saving ? "Guardando…" : "Guardar y verificar sesión"}
      </button>
    </form>
  );
}

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [evCompleted, setEvCompleted] = useState(true);
  const [evFailed, setEvFailed] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, { ok: boolean; ip?: string | null; warn?: string; error?: string } | "loading">>({});
  const [cookieDrafts, setCookieDrafts] = useState<Record<string, string>>({});
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [me, acc, prx] = await Promise.all([
      api<{ profile: Profile | null }>("/me"),
      api<{ accounts: LinkedAccount[] }>("/linkedin-accounts"),
      api<{ proxies: ProxyRow[] }>("/proxies"),
    ]);
    const p = me.profile;
    setProfile(p);
    setWebhookUrl(p?.webhook_url ?? "");
    const ev = p?.webhook_events;
    if (ev && ev.length > 0) {
      setEvCompleted(ev.includes("task.completed"));
      setEvFailed(ev.includes("task.failed"));
    } else {
      setEvCompleted(true);
      setEvFailed(true);
    }
    setAccounts(acc.accounts);
    setProxies(prx.proxies ?? []);
    setProxyDrafts((prev) => {
      const next = { ...prev };
      for (const a of acc.accounts) {
        if (next[a.id] === undefined) next[a.id] = a.proxy_id ?? "";
      }
      return next;
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveWebhooks(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    const webhook_events: ("task.completed" | "task.failed")[] = [];
    if (evCompleted) webhook_events.push("task.completed");
    if (evFailed) webhook_events.push("task.failed");
    try {
      await api("/me", {
        method: "PATCH",
        body: JSON.stringify({
          webhook_url: webhookUrl.trim() || null,
          webhook_events,
        }),
      });
      setMsg("Webhooks guardados.");
      await load();
    } catch (e2: unknown) {
      setMsg(e2 instanceof Error ? e2.message : "Error");
    }
  }

  async function saveAccountConnection(accountId: string) {
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    const acc = accounts.find((x) => x.id === accountId);
    const cookie = (cookieDrafts[accountId] ?? "").trim();
    const proxyRaw = proxyDrafts[accountId] ?? acc?.proxy_id ?? "";
    const proxy_id = proxyRaw === "" ? null : proxyRaw;
    const body: Record<string, unknown> = { proxy_id };
    if (cookie.length >= 10) body.li_at = cookie;
    if (cookie.length > 0 && cookie.length < 10) {
      setMsg("La cookie li_at parece demasiado corta (mín. 10 caracteres).");
      return;
    }
    try {
      await api(`/linkedin-accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setCookieDrafts((d) => ({ ...d, [accountId]: "" }));
      setMsg("Cuenta actualizada. Si pegaste cookie, el worker verificará la sesión.");
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Error");
    }
  }

  async function testProxy(proxyId: string) {
    if (!(await getValidAccessToken())) return;
    setProxyTestResults((r) => ({ ...r, [proxyId]: "loading" }));
    try {
      const res = await api<{ ok: boolean; ip?: string | null; warn?: string; error?: string }>(
        `/proxies/${proxyId}/test`, { method: "POST" }
      );
      setProxyTestResults((r) => ({ ...r, [proxyId]: res }));
    } catch (e) {
      setProxyTestResults((r) => ({ ...r, [proxyId]: { ok: false, error: e instanceof Error ? e.message : "Error" } }));
    }
  }

  async function syncPostsFromLinkedIn(accountId: string) {
    setMsg(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api<{ ok: boolean }>(`/linkedin-accounts/${accountId}/sync-posts`, { method: "POST" });
      setMsg("Sincronización de posts en cola. Cuando el worker termine, verás las publicaciones en Contenido → Posts.");
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Error");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-12 pb-12">
      <div>
        <h1 className="page-title mb-2">Ajustes</h1>
        <p className="page-desc">
          Webhooks, cookie LinkedIn, proxy por cuenta y pool de proxies. Todo lo necesario para que el worker navegue con tu sesión.
        </p>
      </div>

      <section>
        <h2 className={sectionTitle}>Webhooks</h2>
        <p className={sectionDesc}>
          POST JSON cuando una tarea termina (<code className="text-[var(--text)]">completed</code>) o falla tras reintentos (
          <code className="text-[var(--text)]">dead</code>).
        </p>
        <form onSubmit={saveWebhooks} className="card card-pad space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--muted)]">URL del webhook (https)</label>
            <input
              className="input-field"
              placeholder="https://…"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={evCompleted} onChange={(e) => setEvCompleted(e.target.checked)} />
              Notificar <code className="text-xs">task.completed</code>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={evFailed} onChange={(e) => setEvFailed(e.target.checked)} />
              Notificar <code className="text-xs">task.failed</code>
            </label>
          </div>
          <button type="submit" className="btn-primary">
            Guardar webhooks
          </button>
        </form>
      </section>

      <section>
        <h2 className={sectionTitle}>Cuentas LinkedIn</h2>
        <p className={sectionDesc}>
          Inicia sesión en LinkedIn → DevTools (F12) → Application → Cookies → copiá el valor de{" "}
          <code className="text-[var(--text)]">li_at</code> y pegalo acá. Se cifra antes de guardarse.
        </p>

        <NewAccountForm onAdded={load} setMsg={setMsg} />

        {accounts.length > 0 && (
          <ul className="mt-4 space-y-4">
            {accounts.map((a) => (
              <li key={a.id} className="card card-pad space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-[var(--text)]">{a.li_display_name ?? `Cuenta ${a.id.slice(0, 8)}…`}</p>
                    <p className="text-xs text-[var(--muted)]">
                      Estado: <span className="text-[var(--text)]">{a.connection_status}</span>
                      {a.proxy_id && <span className="ml-2 text-green-400">· proxy ✓</span>}
                    </p>
                  </div>
                  <button type="button" className="btn-secondary min-h-9 text-sm" onClick={() => syncPostsFromLinkedIn(a.id)}>
                    Sincronizar posts
                  </button>
                </div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Renovar cookie li_at (dejá vacío para no cambiarla)
                  <textarea
                    className="input-field mt-1 min-h-[88px] py-2 font-mono text-xs"
                    placeholder="Pegar nueva cookie li_at…"
                    value={cookieDrafts[a.id] ?? ""}
                    onChange={(e) => setCookieDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn-primary" onClick={() => saveAccountConnection(a.id)}>
                  Guardar cookie
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>


      {proxies.length > 0 && (
        <section>
          <h2 className={sectionTitle}>Verificar proxies</h2>
          <p className={sectionDesc}>
            Comprueba que cada proxy es alcanzable y obtiene una IP externa correcta.
          </p>
          <ul className="space-y-2">
            {proxies.map((p) => {
              const account = accounts.find((a) => a.id === p.account_id);
              const result = proxyTestResults[p.id];
              return (
                <li key={p.id} className="card card-pad flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-[var(--text)]">{p.host}:{p.port}</p>
                    {account && (
                      <p className="text-xs text-[var(--muted)]">→ {account.li_display_name ?? `…${account.id.slice(-6)}`}</p>
                    )}
                    {!p.account_id && (
                      <p className="text-xs text-[var(--muted)]">Sin cuenta asignada</p>
                    )}
                    {result && result !== "loading" && (
                      <p className={`mt-1 text-xs ${result.ok ? "text-green-400" : "text-red-400"}`}>
                        {result.ok && result.ip && `✓ IP: ${result.ip}`}
                        {result.ok && !result.ip && result.warn && `⚠ ${result.warn}`}
                        {!result.ok && `✗ ${result.error}`}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={result === "loading"}
                    onClick={() => testProxy(p.id)}
                    className="btn-secondary min-h-9 shrink-0 text-sm disabled:opacity-50"
                  >
                    {result === "loading" ? "Probando…" : "Comprobar"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {profile?.email && (
        <p className="text-xs text-[var(--muted)]">
          Sesión app: <span className="text-[var(--text)]">{profile.email}</span>
        </p>
      )}
      {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}
    </div>
  );
}
