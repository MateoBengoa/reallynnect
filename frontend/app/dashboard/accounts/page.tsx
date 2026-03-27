"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
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
  const syncBaseline = useRef<{ at: string | null; name: string | null } | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ accounts: Account[] }>("/linkedin-accounts", token);
    setAccounts(r.accounts);
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
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const acc = accounts.find((x) => x.id === accountId);
    syncBaseline.current = {
      at: acc?.session_verified_at ?? null,
      name: acc?.li_display_name ?? null,
    };
    setSyncingId(accountId);
    try {
      await api<{ ok: boolean }>(`/linkedin-accounts/${accountId}/sync-profile`, token, {
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
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    try {
      await api<{ id: string; verify_task_id: string | null }>("/linkedin-accounts", token, {
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
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api(`/linkedin-accounts/${id}`, token, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Cuentas LinkedIn</h1>
      <p className="mb-4 max-w-2xl text-sm text-[var(--muted)]">
        Inicia sesión en LinkedIn, abre DevTools → Application → Cookies → copia el valor de{" "}
        <code className="text-[var(--text)]">li_at</code> y pégalo aquí. Se cifra antes de guardarse.
      </p>
      <form onSubmit={connect} className="mb-8 max-w-xl space-y-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4">
        <textarea
          className="min-h-[100px] w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5 font-mono text-xs"
          placeholder="Pegar li_at…"
          value={liAt}
          onChange={(e) => setLiAt(e.target.value)}
          required
        />
        {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}
        <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-white">
          Guardar y verificar sesión
        </button>
      </form>
      <ul className="space-y-3">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex min-w-0 flex-1 gap-3">
              {a.li_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.li_photo_url}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-white/10"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/5 text-lg text-[var(--muted)]">
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
                <p className="mt-1 font-mono text-[10px] text-white/30">{a.id}</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-col">
              <button
                type="button"
                disabled={a.connection_status === "pending" || syncingId === a.id}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-[var(--text)] hover:bg-white/10 disabled:opacity-40"
                onClick={() => syncProfile(a.id)}
              >
                {syncingId === a.id ? "Sincronizando…" : "Sincronizar perfil"}
              </button>
              <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">
                {a.connection_status}
                {a.connection_status === "pending" ? " · …" : ""} · {a.softban_status}
              </span>
              <button type="button" className="text-sm text-red-400 hover:underline" onClick={() => remove(a.id)}>
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
