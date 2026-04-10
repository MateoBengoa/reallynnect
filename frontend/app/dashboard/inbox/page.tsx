"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api, apiDownloadBlob } from "@/lib/api";

/* ─── types ──────────────────────────────────────────────────── */
type LiAccount = { id: string; li_display_name: string | null };
type Thread = {
  account_id: string;
  conversation_id: string;
  peer_name: string | null;
  peer_photo_url?: string | null;
  preview: string;
  last_direction: string;
  last_at: string;
  account_label: string;
};
type MsgAttachment = { name: string; kind?: string; download_url?: string | null };
type Msg = {
  id: string;
  message_text: string | null;
  direction: string;
  created_at: string;
  peer_name?: string | null;
  attachments?: MsgAttachment[] | null;
};

/* ─── date helpers ───────────────────────────────────────────── */
/** Diferencia en días de calendario local (0 = mismo día civil que `now`). */
function calendarDayDiffLocal(message: Date, now: Date): number {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((startOfDay(now) - startOfDay(message)) / 86_400_000);
}

function fmtShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffCalDays = calendarDayDiffLocal(d, now);
  const time = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  if (diffMins < 1) return "Ahora";
  if (diffMins < 60) return `Hace ${diffMins} min`;
  if (diffCalDays === 0) return time;
  if (diffCalDays === 1) return `Ayer ${time}`;
  if (diffCalDays < 7) {
    const day = d.toLocaleDateString("es", { weekday: "short" });
    return `${day.charAt(0).toUpperCase() + day.slice(1)} ${time}`;
  }
  const date = d.toLocaleDateString("es", { day: "2-digit", month: "2-digit" });
  return `${date} ${time}`;
}

function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffCalDays = calendarDayDiffLocal(d, now);
  const time = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  if (diffCalDays === 0) return `Hoy ${time}`;
  if (diffCalDays === 1) return `Ayer ${time}`;
  const date = d.toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "2-digit" });
  return `${date} ${time}`;
}

/* ─── attachment download ────────────────────────────────────── */
async function downloadInboxAttachment(accountId: string, remoteUrl: string, filename: string) {
  const q =
    `/inbox/attachment/proxy?account_id=${encodeURIComponent(accountId)}` +
    `&url=${encodeURIComponent(remoteUrl)}` +
    `&filename=${encodeURIComponent(filename)}`;
  const blob = await apiDownloadBlob(q);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/["\r\n]/g, "_").split(/[/\\]/).pop() || "archivo";
  a.rel = "noopener";
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── page ───────────────────────────────────────────────────── */
export default function InboxPage() {
  const [accounts, setAccounts] = useState<LiAccount[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [threadSyncNote, setThreadSyncNote] = useState<string | null>(null);
  const [bgSync, setBgSync] = useState(false);
  const [listPollActive, setListPollActive] = useState(false);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  /* sort threads by last_at desc */
  const sortedThreads = [...threads].sort(
    (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
  );

  /* ── loaders ── */
  const loadAccounts = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ accounts: LiAccount[] }>("/linkedin-accounts");
    setAccounts(r.accounts ?? []);
    setAccountId((prev) => prev || r.accounts?.[0]?.id || "");
  }, []);

  const loadThreads = useCallback(async () => {
    if (!(await getValidAccessToken()) || !accountId) return;
    const r = await api<{ threads: Thread[] }>(`/inbox?account_id=${encodeURIComponent(accountId)}`);
    setThreads(r.threads ?? []);
  }, [accountId]);

  const loadThreadMessages = useCallback(async (t: Thread) => {
    if (!(await getValidAccessToken())) return;
    const q =
      `/inbox/thread?account_id=${encodeURIComponent(t.account_id)}` +
      `&conversation_id=${encodeURIComponent(t.conversation_id)}`;
    const r = await api<{ messages: Msg[] }>(q);
    setMessages(r.messages ?? []);
  }, []);

  /* ── poll after sync ── */
  const startThreadsPollAfterSync = useCallback(() => {
    if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
    setListPollActive(true);
    let ticks = 0;
    syncPollRef.current = setInterval(async () => {
      ticks += 1;
      try { await loadThreads(); } catch { /* ignore */ }
      if (ticks >= 45) {
        if (syncPollRef.current) clearInterval(syncPollRef.current);
        syncPollRef.current = null;
        setListPollActive(false);
      }
    }, 3000);
  }, [loadThreads]);

  /* ── effects ── */
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  useEffect(() => { if (accountId) loadThreads(); }, [accountId, loadThreads]);

  /* auto-sync on account change */
  useEffect(() => {
    if (!accountId) return;
    setSyncNote(null);
    let cancelled = false;
    (async () => {
      if (!(await getValidAccessToken()) || cancelled) return;
      try {
        setBgSync(true);
        const res = await api<{ task_id?: string; instant?: boolean; conversations?: number }>(
          "/inbox/sync",
          { method: "POST", body: JSON.stringify({ account_id: accountId, background: true }) }
        );
        if (cancelled) return;
        if (res.instant) {
          setSyncNote(`${res.conversations ?? "—"} conversaciones`);
          await loadThreads();
        } else {
          startThreadsPollAfterSync();
        }
      } catch { /* net/queue — list still shows cached data */ }
      finally { if (!cancelled) setBgSync(false); }
    })();
    return () => {
      cancelled = true;
      setBgSync(false);
      if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
      setListPollActive(false);
    };
  }, [accountId, startThreadsPollAfterSync, loadThreads]);

  /* background poll every 8s */
  useEffect(() => {
    if (!accountId) return;
    const id = setInterval(loadThreads, 8000);
    return () => clearInterval(id);
  }, [accountId, loadThreads]);

  /* thread sync */
  useEffect(() => {
    if (!selected) { setThreadSyncNote(null); return; }
    let cancelled = false;
    const pollRef: { current: ReturnType<typeof setInterval> | null } = { current: null };
    setMessages([]);
    setThreadSyncNote("Sincronizando mensajes…");
    (async () => {
      if (!(await getValidAccessToken()) || cancelled) return;
      try {
        await api("/inbox/thread/sync", {
          method: "POST",
          body: JSON.stringify({ account_id: selected.account_id, conversation_id: selected.conversation_id }),
        });
      } catch { /* ignore */ }
      if (cancelled) return;
      try { await loadThreadMessages(selected); } catch { /* ignore */ }
      let ticks = 0;
      pollRef.current = setInterval(async () => {
        if (cancelled) return;
        ticks += 1;
        try { await loadThreadMessages(selected); } catch { /* ignore */ }
        if (ticks >= 2) setThreadSyncNote(null);
        if (ticks >= 36 && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }, 1600);
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selected, loadThreadMessages]);

  /* scroll to bottom when messages load */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* cleanup on unmount */
  useEffect(() => {
    return () => {
      if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
    };
  }, []);

  /* ── send ── */
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !draft.trim()) return;
    setErr(null);
    if (!(await getValidAccessToken())) return;
    setBusy(true);
    try {
      await api("/inbox/send", {
        method: "POST",
        body: JSON.stringify({
          account_id: selected.account_id,
          conversation_id: selected.conversation_id,
          text: draft.trim(),
        }),
      });
      setDraft("");
      setTimeout(() => loadThreadMessages(selected), 6000);
      setTimeout(loadThreads, 6000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /* ── render ── */
  return (
    <div className="flex h-[min(720px,calc(100vh-11rem))] flex-col gap-4 lg:flex-row">

      {/* ── left panel: thread list ── */}
      <div className="card flex w-full flex-col overflow-hidden p-0 lg:w-72 lg:shrink-0">
        <div className="border-b border-[var(--border)] px-3 pb-2 pt-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="page-title text-lg sm:text-xl">Inbox</h1>
            <div className="flex items-center gap-1.5">
              {(bgSync || listPollActive) && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" title="Sincronizando…" />
              )}
              {syncNote && (
                <span className="text-[10px] text-[var(--muted)]">{syncNote}</span>
              )}
              {threads.length > 0 && (
                <span className="text-[10px] text-[var(--muted)]">{threads.length}</span>
              )}
            </div>
          </div>

          {accounts.length > 1 && (
            <select
              className="input-field mt-2 min-h-[2.25rem] py-1.5 text-sm"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setSelected(null); setMessages([]); }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.li_display_name ?? a.id.slice(0, 8) + "…"}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sortedThreads.length === 0 ? (
            <p className="p-3 text-xs text-[var(--muted)]">
              {bgSync || listPollActive ? "Cargando conversaciones…" : "Sin conversaciones."}
            </p>
          ) : (
            <ul>
              {sortedThreads.map((t) => {
                const active =
                  selected?.account_id === t.account_id &&
                  selected?.conversation_id === t.conversation_id;
                return (
                  <li key={`${t.account_id}-${t.conversation_id}`}>
                    <button
                      type="button"
                      onClick={() => setSelected(t)}
                      className={`flex w-full gap-2.5 border-b border-[var(--border)] px-3 py-2.5 text-left text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] ${
                        active ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : ""
                      }`}
                    >
                      {t.peer_photo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={t.peer_photo_url}
                          alt=""
                          className="mt-0.5 size-9 shrink-0 rounded-full object-cover"
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-[11px] font-semibold text-[var(--muted)]">
                          {(t.peer_name ?? "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="truncate text-sm font-medium text-[var(--text)]">
                            {t.peer_name || t.conversation_id.slice(0, 20)}
                          </span>
                          <span className="shrink-0 text-[10px] text-[var(--muted)]">
                            {fmtShort(t.last_at)}
                          </span>
                        </div>
                        <div className="truncate text-xs text-[var(--muted)]">
                          {t.last_direction === "out" && (
                            <span className="mr-0.5 text-[var(--accent)]">Tú:</span>
                          )}
                          {t.preview || "—"}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── right panel: messages ── */}
      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--muted)]">
            Elige una conversación.
          </div>
        ) : (
          <>
            {/* header */}
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
              {selected.peer_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.peer_photo_url}
                  alt=""
                  className="size-9 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-sm font-semibold text-[var(--muted)]">
                  {(selected.peer_name ?? "?").charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <h2 className="font-medium">{selected.peer_name || selected.conversation_id}</h2>
                <p className="text-xs text-[var(--muted)]">{selected.account_label}</p>
              </div>
              {threadSyncNote && (
                <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--muted)]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
                  {threadSyncNote}
                </span>
              )}
            </div>

            {/* messages */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="flex flex-col gap-2">
                {messages.map((m) => {
                  const atts = Array.isArray(m.attachments) ? m.attachments : [];
                  const text = (m.message_text ?? "").trim();
                  const emptyBody = !text && atts.length === 0;
                  const isOut = m.direction === "out";
                  return (
                    <div key={m.id} className="flex w-full flex-col">
                      <div className={`flex w-full ${isOut ? "justify-end" : "justify-start"}`}>
                        <div className="flex max-w-[78%] flex-col">
                          <div
                            className={`rounded-[var(--radius-md)] px-3 py-2 text-sm ${
                              isOut
                                ? "bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]"
                                : "bg-[color-mix(in_srgb,var(--text)_7%,transparent)]"
                            }`}
                          >
                            {text ? (
                              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{text}</pre>
                            ) : emptyBody ? (
                              <p className="font-sans text-sm text-[var(--muted)]">
                                Sin texto — esperando sincronización…
                              </p>
                            ) : null}

                            {atts.length > 0 && (
                              <ul className={`space-y-1.5 ${text ? "mt-2" : ""}`}>
                                {atts.map((a, i) => {
                                  const du = a.download_url?.trim();
                                  const liThread = selected
                                    ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(selected.conversation_id)}/`
                                    : "";
                                  return (
                                    <li
                                      key={`${m.id}-att-${i}`}
                                      className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_40%,transparent)] px-2 py-1.5 text-xs"
                                    >
                                      <span className="shrink-0 text-[var(--muted)]">
                                        {a.kind === "pdf" ? "PDF" : a.kind ? a.kind.toUpperCase() : "📎"}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate font-medium" title={a.name}>
                                        {a.name}
                                      </span>
                                      {du ? (
                                        <button
                                          type="button"
                                          className="btn-secondary min-h-7 shrink-0 px-2 py-0.5 text-[11px]"
                                          onClick={() =>
                                            selected &&
                                            downloadInboxAttachment(selected.account_id, du, a.name).catch((e) =>
                                              alert(e instanceof Error ? e.message : String(e))
                                            )
                                          }
                                        >
                                          Descargar
                                        </button>
                                      ) : liThread ? (
                                        <a
                                          href={liThread}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="shrink-0 text-[11px] text-[var(--accent)] underline underline-offset-2"
                                        >
                                          Ver en LinkedIn
                                        </a>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                          <span
                            className={`mt-0.5 text-[10px] text-[var(--muted)] ${isOut ? "text-right" : "text-left"}`}
                          >
                            {fmtFull(m.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* compose */}
            <form onSubmit={sendMessage} className="shrink-0 border-t border-[var(--border)] p-3">
              {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
              <textarea
                className="input-field mb-2 min-h-[68px] resize-none py-2 text-sm"
                placeholder="Escribe un mensaje…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendMessage(e as unknown as React.FormEvent);
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--muted)]">⌘↵ para enviar</span>
                <button type="submit" disabled={busy || !draft.trim()} className="btn-primary disabled:opacity-50">
                  Enviar
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
