"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getValidAccessToken } from "@/lib/supabase";
import { api, apiDownloadBlob } from "@/lib/api";

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

type Msg = {
  id: string;
  message_text: string | null;
  direction: string;
  created_at: string;
  peer_name?: string | null;
  attachments?: MsgAttachment[] | null;
};

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
  const [threadSyncNote, setThreadSyncNote] = useState<string | null>(null);
  const [bgSync, setBgSync] = useState(false);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAccounts = useCallback(async () => {
    const token = await getValidAccessToken();
    if (!token) return;
    const r = await api<{ accounts: LiAccount[] }>("/linkedin-accounts");
    setAccounts(r.accounts ?? []);
    setAccountId((prev) => prev || r.accounts?.[0]?.id || "");
  }, []);

  const loadThreads = useCallback(async () => {
    const token = await getValidAccessToken();
    if (!token || !accountId) return;
    const q = `/inbox?account_id=${encodeURIComponent(accountId)}`;
    const r = await api<{ threads: Thread[]; last_message_at?: string | null }>(q);
    setThreads(r.threads ?? []);
    setLastMessageAt(r.last_message_at ?? null);
  }, [accountId]);

  const loadThreadMessages = useCallback(async (t: Thread) => {
    const token = await getValidAccessToken();
    if (!token) return;
    const q =
      `/inbox/thread?account_id=${encodeURIComponent(t.account_id)}` +
      `&conversation_id=${encodeURIComponent(t.conversation_id)}`;
    const r = await api<{ messages: Msg[] }>(q);
    setMessages(r.messages ?? []);
  }, []);

  const startThreadsPollAfterSync = useCallback(() => {
    if (syncPollRef.current) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
    }
    let ticks = 0;
    syncPollRef.current = setInterval(async () => {
      ticks += 1;
      try {
        await loadThreads();
      } catch {
        /* ignorar */
      }
      if (ticks >= 45) {
        if (syncPollRef.current) clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    }, 3000);
  }, [loadThreads]);

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
    let cancelled = false;
    (async () => {
      const token = await getValidAccessToken();
      if (!token || cancelled) return;
      try {
        setBgSync(true);
        setSyncNote((prev) => prev ?? "Actualizando la lista de conversaciones con LinkedIn (cola del worker)…");
        await api<{ task_id?: string; deduped?: boolean }>("/inbox/sync", {
          method: "POST",
          body: JSON.stringify({ account_id: accountId, background: true }),
        });
        if (!cancelled) startThreadsPollAfterSync();
      } catch {
        /* cola / red: la lista igual muestra lo ya guardado */
      } finally {
        if (!cancelled) setBgSync(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, startThreadsPollAfterSync]);

  useEffect(() => {
    if (!selected) {
      setThreadSyncNote(null);
      return;
    }
    let cancelled = false;
    const intervalRef: { current: ReturnType<typeof setInterval> | null } = { current: null };
    setMessages([]);
    setThreadSyncNote("Sincronizando mensajes de este chat con el worker…");
    (async () => {
      const token = await getValidAccessToken();
      if (!token || cancelled) return;
      try {
        await api<{ task_id?: string; deduped?: boolean }>("/inbox/thread/sync", {
          method: "POST",
          body: JSON.stringify({
            account_id: selected.account_id,
            conversation_id: selected.conversation_id,
          }),
        });
      } catch {
        /* red / cola: seguimos haciendo poll por si ya hay datos */
      }
      if (cancelled) return;
      try {
        await loadThreadMessages(selected);
      } catch {
        /* ignorar */
      }
      let ticks = 0;
      intervalRef.current = setInterval(async () => {
        if (cancelled) return;
        ticks += 1;
        try {
          await loadThreadMessages(selected);
        } catch {
          /* ignorar */
        }
        if (ticks >= 2) setThreadSyncNote(null);
        if (ticks >= 36 && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }, 1600);
    })();
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [selected, loadThreadMessages]);

  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
    };
  }, []);

  async function syncNow(opts?: { force?: boolean }) {
    setErr(null);
    setSyncNote(null);
    if (syncPollRef.current) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
    }
    if (!(await getValidAccessToken())) {
      setErr("No hay sesión. Vuelve a iniciar sesión.");
      return;
    }
    if (!accountId) {
      setErr("No hay cuenta LinkedIn seleccionada. Añade una en Cuentas.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ task_id?: string; deduped?: boolean; ok?: boolean; error?: string }>("/inbox/sync", {
        method: "POST",
        body: JSON.stringify({
          account_id: accountId,
          ...(opts?.force ? { force: true } : {}),
        }),
      });
      const tid = res.task_id ? `${res.task_id.slice(0, 8)}…` : "";
      if (res.deduped) {
        setSyncNote(
          `Ya hay una sincronización de lista encolada o en curso para esta cuenta (tarea ${tid || "—"}). El worker la ejecuta en Chrome (Playwright). Mira ` +
            `«Tareas» en el menú si no avanza. Si lleva bloqueada mucho tiempo, pulsa «Forzar nueva sincronización» abajo.`
        );
      } else if (opts?.force) {
        setSyncNote(
          "Se cancelaron las sync de lista anteriores y se encoló una nueva. El worker la procesará en breve en Chrome."
        );
      } else {
        setSyncNote(
          "Sincronización de la lista encolada. El worker actualizará nombres y vistas previas en el panel izquierdo; el texto completo de cada chat se carga al abrirlo."
        );
      }
      startThreadsPollAfterSync();
      setTimeout(() => {
        setSyncNote((prev) =>
          prev
            ? `${prev} Si la lista sigue vacía: revisa Tareas y la consola del worker «[inbox_sync]».`
            : null
        );
      }, 135_000);
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
    const token = await getValidAccessToken();
    if (!token) return;
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
    <div className="flex h-[min(720px,calc(100vh-11rem))] flex-col gap-4 lg:flex-row">
      <div className="card flex w-full flex-col overflow-hidden p-0 shadow-[var(--shadow-sm)] lg:w-72 lg:shrink-0">
        <div className="border-b border-[var(--border)] p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="page-title text-lg sm:text-xl">Inbox</h1>
            {accountId ? (
              <span className="shrink-0 text-[10px] text-[var(--muted)]">{threads.length} conversaciones</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Al entrar se actualiza la lista de conversaciones (izquierda) con LinkedIn; no descarga el historial completo
            de todos los chats. Al abrir un chat, el worker sincroniza las burbujas de ese hilo.
          </p>
          {lastMessageAt && (
            <p className="mt-1 text-[10px] text-[var(--muted)]">
              Última actividad (lista o mensajes): {new Date(lastMessageAt).toLocaleString()}
            </p>
          )}
          {bgSync && (
            <p className="mt-1 text-[10px] text-emerald-200/80">Encolando actualización con LinkedIn…</p>
          )}
          <select
            className="input-field mt-2 min-h-[2.5rem] py-2 text-sm"
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
            onClick={() => syncNow()}
            className="btn-secondary mt-2 w-full disabled:opacity-50"
          >
            Sincronizar ahora
          </button>
          <button
            type="button"
            disabled={busy || !accountId}
            onClick={() => syncNow({ force: true })}
            className="link-focus mt-1 w-full rounded-md px-1 py-1 text-left text-[11px] text-[var(--accent)] underline underline-offset-2 disabled:opacity-50"
          >
            Forzar nueva sincronización (cancela la de lista pendiente o en curso)
          </button>
          {syncNote && (
            <p className="mt-2 text-[11px] leading-snug text-[var(--muted)]">{syncNote}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <p className="p-3 text-sm text-[var(--muted)]">
              Aún no hay conversaciones en la lista. Suele llenarse en uno o varios minutos si el worker está en marcha;
              si no, pulsa «Sincronizar ahora». Si falla, revisa{" "}
              <Link href="/dashboard/tasks" className="link-focus rounded-sm text-[var(--accent)] underline underline-offset-2">
                Tareas
              </Link>{" "}
              y la consola «[inbox_sync]».
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
                    className={`flex min-h-10 w-full gap-2 border-b border-[var(--border)] px-3 py-2 text-left text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))] ${active ? "bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))]" : ""}`}
                  >
                    {t.peer_photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={t.peer_photo_url}
                        alt=""
                        className="mt-0.5 size-9 shrink-0 rounded-full object-cover"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="mt-0.5 size-9 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))]" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{t.peer_name || t.conversation_id.slice(0, 24)}</div>
                      <div className="truncate text-xs text-[var(--muted)]">{t.preview || "—"}</div>
                      <div className="text-[10px] uppercase text-[var(--muted)]">
                        {t.last_direction === "out" ? "Tú · " : ""}
                        {new Date(t.last_at).toLocaleString()}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden p-0 shadow-[var(--shadow-sm)]">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--muted)]">
            Elige una conversación.
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] px-4 py-3">
              {selected.peer_photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selected.peer_photo_url}
                  alt=""
                  className="size-10 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              <div className="min-w-0">
                <h2 className="font-medium">{selected.peer_name || selected.conversation_id}</h2>
                <p className="text-xs text-[var(--muted)]">{selected.account_label}</p>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 text-sm">
              {threadSyncNote && (
                <p className="mb-2 text-xs text-[var(--muted)]">{threadSyncNote}</p>
              )}
              {messages.map((m) => {
                const atts = Array.isArray(m.attachments) ? m.attachments : [];
                const text = (m.message_text ?? "").trim();
                const emptyBody = !text && atts.length === 0;
                return (
                  <div
                    key={m.id}
                    className={`max-w-[85%] rounded-[var(--radius-md)] px-3 py-2 ${
                      m.direction === "out"
                        ? "ml-auto bg-[color-mix(in_srgb,var(--accent)_22%,var(--surface))]"
                        : "mr-auto bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))]"
                    }`}
                  >
                    {text ? (
                      <pre className="whitespace-pre-wrap font-sans text-sm">{text}</pre>
                    ) : emptyBody ? (
                      <p className="font-sans text-sm text-[var(--muted)]">
                        Sin texto. Espera unos segundos a que termine la sincronización del hilo o revisa Tareas /
                        consola «[inbox_thread_sync]».
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
                              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_70%,var(--surface))] px-2 py-1.5 text-xs"
                            >
                              <span className="shrink-0 text-[var(--muted)]" aria-hidden>
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
                                  Abrir en LinkedIn
                                </a>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="mt-1 text-[10px] text-[var(--muted)]">
                      {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
            <form onSubmit={sendMessage} className="shrink-0 border-t border-[var(--border)] p-3">
              {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
              <textarea
                className="input-field mb-2 min-h-[72px] py-2 text-sm"
                placeholder="Escribe un mensaje…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" disabled={busy || !draft.trim()} className="btn-primary disabled:opacity-50">
                Enviar (cola)
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
