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

type Proxy = {
  id: string;
  host: string;
  port: number;
  username: string | null;
  status: string;
};

const sectionTitle = "mb-1 text-lg font-semibold tracking-tight text-[var(--text)]";
const sectionDesc = "mb-4 text-sm text-[var(--muted)]";

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [evCompleted, setEvCompleted] = useState(true);
  const [evFailed, setEvFailed] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [cookieDrafts, setCookieDrafts] = useState<Record<string, string>>({});
  const [proxyDrafts, setProxyDrafts] = useState<Record<string, string>>({});

  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState(80);
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPass, setProxyPass] = useState("");
  const [proxyErr, setProxyErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [me, acc, px] = await Promise.all([
      api<{ profile: Profile | null }>("/me"),
      api<{ accounts: LinkedAccount[] }>("/linkedin-accounts"),
      api<{ proxies: Proxy[] }>("/proxies"),
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
    setProxies(px.proxies);
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

  async function addProxy(e: React.FormEvent) {
    e.preventDefault();
    setProxyErr(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/proxies", {
        method: "POST",
        body: JSON.stringify({
          host: proxyHost,
          port: proxyPort,
          username: proxyUser || undefined,
          password: proxyPass || undefined,
        }),
      });
      setProxyHost("");
      setProxyPass("");
      await load();
    } catch (e2: unknown) {
      setProxyErr(e2 instanceof Error ? e2.message : "Error");
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
        <h2 className={sectionTitle}>Cookie LinkedIn (li_at) y proxy por cuenta</h2>
        <p className={sectionDesc}>
          DevTools → Application → Cookies → <code className="text-[var(--text)]">li_at</code>. Se cifra en el servidor. El proxy se usa en Playwright
          para esa cuenta.
        </p>
        {accounts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No hay cuentas. Añade una en Cuentas LinkedIn o aquí mismo no podrás asignar cookie.</p>
        ) : (
          <ul className="space-y-4">
            {accounts.map((a) => (
              <li key={a.id} className="card card-pad space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-[var(--text)]">{a.li_display_name ?? `Cuenta ${a.id.slice(0, 8)}…`}</p>
                    <p className="text-xs text-[var(--muted)]">
                      Estado: <span className="text-[var(--text)]">{a.connection_status}</span>
                    </p>
                  </div>
                  <button type="button" className="btn-secondary min-h-9 text-sm" onClick={() => syncPostsFromLinkedIn(a.id)}>
                    Sincronizar posts
                  </button>
                </div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Proxy
                  <select
                    className="input-field mt-1 min-h-[2.5rem] py-2 text-sm"
                    value={proxyDrafts[a.id] ?? a.proxy_id ?? ""}
                    onChange={(e) => setProxyDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                  >
                    <option value="">Sin proxy (directo)</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.host}:{p.port} {p.username ? `(${p.username})` : ""} · {p.status}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Nueva cookie li_at (opcional; vacío = no cambiar)
                  <textarea
                    className="input-field mt-1 min-h-[88px] py-2 font-mono text-xs"
                    placeholder="Pegar solo si quieres renovar la sesión…"
                    value={cookieDrafts[a.id] ?? ""}
                    onChange={(e) => setCookieDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn-primary" onClick={() => saveAccountConnection(a.id)}>
                  Guardar proxy / cookie
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className={sectionTitle}>Pool de proxies</h2>
        <p className={sectionDesc}>Mismos datos que en la pantalla Proxies: host, puerto y credenciales opcionales (p. ej. Webshare).</p>
        <form onSubmit={addProxy} className="card card-pad mb-6 grid gap-3 sm:grid-cols-2">
          <input
            className="input-field sm:col-span-2"
            placeholder="Host"
            value={proxyHost}
            onChange={(e) => setProxyHost(e.target.value)}
            required
          />
          <input
            type="number"
            className="input-field"
            placeholder="Puerto"
            value={proxyPort}
            onChange={(e) => setProxyPort(Number(e.target.value))}
          />
          <input
            className="input-field"
            placeholder="Usuario (opcional)"
            value={proxyUser}
            onChange={(e) => setProxyUser(e.target.value)}
          />
          <input
            type="password"
            className="input-field sm:col-span-2"
            placeholder="Contraseña proxy"
            value={proxyPass}
            onChange={(e) => setProxyPass(e.target.value)}
          />
          {proxyErr && <p className="text-sm text-red-400 sm:col-span-2">{proxyErr}</p>}
          <button type="submit" className="btn-primary sm:col-span-2">
            Añadir proxy al pool
          </button>
        </form>
        <ul className="space-y-2">
          {proxies.map((p) => (
            <li key={p.id} className="card card-pad flex flex-wrap justify-between gap-2 py-2 text-sm shadow-none">
              <span>
                {p.host}:{p.port} {p.username ? `(${p.username})` : ""}
              </span>
              <span className="text-[var(--muted)]">{p.status}</span>
            </li>
          ))}
        </ul>
        {proxies.length === 0 && <p className="text-sm text-[var(--muted)]">Aún no hay proxies en el pool.</p>}
      </section>

      {profile?.email && (
        <p className="text-xs text-[var(--muted)]">
          Sesión app: <span className="text-[var(--text)]">{profile.email}</span>
        </p>
      )}
      {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}
    </div>
  );
}
