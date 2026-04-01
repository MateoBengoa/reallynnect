"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type CommentEvent = {
  id: string;
  account_id: string;
  rule_id: string;
  event_type: "comment_reply" | "dm_followup" | "skip" | "error";
  detail: Record<string, unknown> | null;
  created_at: string;
};

const EVENT_STYLES: Record<string, string> = {
  comment_reply: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
  dm_followup:   "border-blue-400/30 bg-blue-400/10 text-blue-400",
  skip:          "border-amber-400/30 bg-amber-400/10 text-amber-400",
  error:         "border-red-400/30 bg-red-400/10 text-red-400",
};

const EVENT_LABELS: Record<string, string> = {
  comment_reply: "Comentario",
  dm_followup:   "DM Seguimiento",
  skip:          "Omitido",
  error:         "Error",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function ContentEventsPage() {
  const [events, setEvents] = useState<CommentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ events: CommentEvent[] }>("/inbound-comment-events");
    setEvents(r.events ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-w-0">
      <Link
        href="/dashboard/content/posts"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">←</span>
        Volver a Posts
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title mb-1">Eventos de comentarios</h1>
          <p className="page-desc">Historial de respuestas automáticas y DMs de seguimiento generados por las reglas.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="btn-secondary py-1.5 text-xs">
            ↺ Refrescar
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--accent)]"
            />
            Auto (10s)
          </label>
        </div>
      </header>

      {/* Counters */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(["comment_reply", "dm_followup", "skip", "error"] as const).map((t) => (
          <span
            key={t}
            className={`rounded-[var(--radius-md)] border px-2.5 py-1 text-xs font-medium ${EVENT_STYLES[t]}`}
          >
            {EVENT_LABELS[t]}: <span className="font-bold">{counts[t] ?? 0}</span>
          </span>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Cargando…</p>
      ) : events.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--text)]">Sin eventos todavía</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Los eventos aparecen cuando el worker ejecuta <code className="text-[var(--text)]">poll_comments</code>.
            Asegurate de tener reglas activas de tipo Comentario y un <code className="text-[var(--text)]">GEMINI_API_KEY</code> configurado si usás IA.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))]">
                <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Tipo</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Detalle</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Regla</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Hace</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const style = EVENT_STYLES[e.event_type] ?? "border-[var(--border)] text-[var(--muted)]";
                const label = EVENT_LABELS[e.event_type] ?? e.event_type;
                const postUrl = e.detail?.post_url as string | undefined;
                const keyword = e.detail?.keyword as string | undefined;
                const reason = e.detail?.reason as string | undefined;
                const errMsg = e.detail?.error as string | undefined;
                const profileUrl = e.detail?.profile_url as string | undefined;
                return (
                  <tr
                    key={e.id}
                    className="border-b border-[var(--border)]/50 bg-[var(--surface)] transition-colors hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))]"
                  >
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${style}`}>
                        {label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {keyword && <span className="mr-1.5 font-semibold text-[var(--text)]">«{keyword}»</span>}
                      {postUrl && (
                        <a
                          href={postUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--accent)] underline-offset-2 hover:underline"
                        >
                          ver post ↗
                        </a>
                      )}
                      {profileUrl && (
                        <a
                          href={profileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1.5 text-[var(--accent)] underline-offset-2 hover:underline"
                        >
                          ver perfil ↗
                        </a>
                      )}
                      {reason && <span className="font-mono text-amber-400">{reason}</span>}
                      {errMsg && !reason && <span className="font-mono text-red-400">{errMsg}</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--muted)]">{e.rule_id.slice(0, 8)}…</td>
                    <td className="px-3 py-2 font-mono text-[var(--muted)]" title={e.created_at}>
                      {relativeTime(e.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
