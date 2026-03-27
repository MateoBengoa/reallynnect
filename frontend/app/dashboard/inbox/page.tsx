"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";

type LiAccount = { id: string; li_display_name: string | null };
type Thread = {
  account_id: string;
  conversation_id: string;
  peer_name: string | null;
  preview: string;
  last_direction: string;
  last_at: string;
  account_label: string;
};
type Msg = {
  id: string;
  message_text: string | null;
  direction: string;
  created_at: string;
  peer_name?: string | null;
};

const INBOX_AUTO_SYNC_COOLDOWN_MS = 7 * 60 * 1000;

export default function InboxPage() {
  const [accounts, setAccounts] = useState<LiAccount[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [bgSync, setBgSync] = useState(false);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ accounts: LiAccount[] }>("/linkedin-accounts", token);
    setAccounts(r.accounts ?? []);
    setAccountId((prev) => prev || r.accounts?.[0]?.id || "");
  }, []);

  const loadThreads = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token || !accountId) return;
    const q = `/inbox?account_id=${encodeURIComponent(accountId)}`;
    const r = await api<{ threads: Thread[]; last_message_at?: string | null }>(q, token);
    setThreads(r.threads ?? []);
    setLastMessageAt(r.last_message_at ?? null);
  }, [accountId]);

  const loadThreadMessages = useCallback(async (t: Thread) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const q =
      `/inbox/thread?account_id=${encodeURIComponent(t.account_id)}` +
      `&conversation_id=${encodeURIComponent(t.conversation_id)}`;
    const r = await api<{ messages: Msg[] }>(q, token);
    setMessages(r.messages ?? []);
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (accountId) loadThreads();
  }, [accountId, loadThreads]);

  useEffect(() => {
    if (!accountId) return;
    const id = setInterval(loadThreads, 5000);
    return () => clearInterval(id);
  }, [accountId, loadThreads]);

  useEffect(() => {
    if (!accountId) return;
    const key = `inbox_auto_sync_${accountId}`;
    const last = Number(sessionStorage.getItem(key) || "0");
    if (Date.now() - last < INBOX_AUTO_SYNC_COOLDOWN_MS) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;
      try {
        setBgSync(true);
        await api<{ task_id?: string; deduped?: boolean }>("/inbox/sync", token, {
          method: "POST",
          body: JSON.stringify({ account_id: accountId, background: true }),
        });
        sessionStorage.setItem(key, String(Date.now()));
      } catch {
        /* cola / red: la lista igual muestra lo ya guardado */
      } finally {
        if (!cancelled) setBgSync(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (selected) loadThreadMessages(selected);
  }, [selected, loadThreadMessages]);

  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
    };
  }, []);

  async function syncNow() {
    setErr(null);
    setSyncNote(null);
    if (syncPollRef.current) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token || !accountId) return;
    setBusy(true);
    try {
      await api<{ task_id: string }>("/inbox/sync", token, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId }),
      });
      setSyncNote(
        "Actualizando con LinkedIn en segundo plano. La lista se refresca sola cada pocos segundos."
      );
      let ticks = 0;
      syncPollRef.current = setInterval(async () => {
        ticks += 1;
        try {
          await loadThreads();
        } catch {
          /* ignorar hasta que la API vuelva */
        }
        if (ticks >= 40) {
          if (syncPollRef.current) clearInterval(syncPollRef.current);
          syncPollRef.current = null;
          setSyncNote((prev) =>
            prev
              ? `${prev} Si sigue vacío: revisa Tareas (errores del worker) y la consola del worker «[inbox_sync]».`
              : null
          );
        }
      }, 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !draft.trim()) return;
    setErr(null);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    setBusy(true);
    try {
      await api("/inbox/send", token, {
        method: "POST",
        body: JSON.stringify({
          account_id: selected.account_id,
          conversation_id: selected.conversation_id,
          text: draft.trim(),
        }),
      });
      setDraft("");
      setSyncNote("Mensaje encolado; el worker lo enviará con tu sesión LinkedIn.");
      setTimeout(() => loadThreadMessages(selected), 6000);
      setTimeout(loadThreads, 6000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[min(720px,calc(100vh-8rem))] flex-col gap-4 lg:flex-row">
      <div className="flex w-full flex-col border border-white/10 bg-[var(--surface)] lg:w-72 lg:shrink-0 lg:rounded-lg">
        <div className="border-b border-white/10 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="text-lg font-semibold">Inbox</h1>
            {accountId ? (
              <span className="shrink-0 text-[10px] text-[var(--muted)]">{threads.length} conversaciones</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Lo que ya guardó el worker se muestra al entrar. Al abrir esta página pedimos una sync en segundo plano
            (sin duplicar si ya hay una en cola).
          </p>
          {lastMessageAt && (
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Último mensaje en base de datos: {new Date(lastMessageAt).toLocaleString()}
            </p>
          )}
          {bgSync && (
            <p className="mt-1 text-[10px] text-emerald-200/80">Encolando actualización con LinkedIn…</p>
          )}
          <select
            className="mt-2 w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm"
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setSelected(null);
              setMessages([]);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.li_display_name ?? a.id.slice(0, 8) + "…"}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !accountId}
            onClick={syncNow}
            className="mt-2 w-full rounded border border-white/20 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
          >
            Sincronizar ahora
          </button>
          {syncNote && (
            <p className="mt-2 text-[11px] leading-snug text-[var(--muted)]">{syncNote}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <p className="p-3 text-sm text-[var(--muted)]">
              Aún no hay conversaciones en base de datos. Suele llenarse en uno o varios minutos si el worker está en
              marcha; si no, pulsa «Sincronizar ahora». Si falla la sync, revisa{" "}
              <Link href="/dashboard/tasks" className="text-[var(--accent)] underline underline-offset-2">
                Tareas
              </Link>{" "}
              y la consola del worker «[inbox_sync]».
            </p>
          )}
          <ul>
            {threads.map((t) => {
              const active =
                selected?.account_id === t.account_id && selected?.conversation_id === t.conversation_id;
              return (
                <li key={`${t.account_id}-${t.conversation_id}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(t)}
                    className={`w-full border-b border-white/5 px-3 py-2 text-left text-sm hover:bg-white/5 ${active ? "bg-white/10" : ""}`}
                  >
                    <div className="font-medium">{t.peer_name || t.conversation_id.slice(0, 24)}</div>
                    <div className="truncate text-xs text-[var(--muted)]">{t.preview || "—"}</div>
                    <div className="text-[10px] uppercase text-[var(--muted)]">
                      {t.last_direction === "out" ? "Tú · " : ""}
                      {new Date(t.last_at).toLocaleString()}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-[var(--surface)]">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--muted)]">
            Elige una conversación.
          </div>
        ) : (
          <>
            <div className="border-b border-white/10 px-4 py-3">
              <h2 className="font-medium">{selected.peer_name || selected.conversation_id}</h2>
              <p className="text-xs text-[var(--muted)]">{selected.account_label}</p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 text-sm">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-lg px-3 py-2 ${
                    m.direction === "out" ? "ml-auto bg-[var(--accent)]/25" : "mr-auto bg-white/5"
                  }`}
                >
                  <pre className="whitespace-pre-wrap font-sans text-sm">
                    {(m.message_text ?? "").trim() ||
                      "Sin texto guardado para este mensaje. Vuelve a sincronizar o revisa la consola del worker «[inbox_sync]»."}
                  </pre>
                  <div className="mt-1 text-[10px] text-[var(--muted)]">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={sendMessage} className="border-t border-white/10 p-3">
              {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
              <textarea
                className="mb-2 min-h-[72px] w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-sm"
                placeholder="Escribe un mensaje…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Enviar (cola)
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
