"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

function isWaiting(t: Task): boolean {
  return t.status === "pending" && new Date(t.scheduled_at).getTime() > Date.now() + 5_000;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "ahora";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

type Task = {
  id: string;
  action: string;
  status: string;
  account_id: string | null;
  lead_id: string | null;
  enrollment_id: string | null;
  scheduled_at: string;
  created_at: string;
  attempts: number;
  error_message: string | null;
  payload: Record<string, unknown> | null;
};

const STATUS_STYLES: Record<string, string> = {
  pending:   "bg-amber-400/15 text-amber-400 border-amber-400/30",
  running:   "bg-blue-400/15 text-blue-400 border-blue-400/30",
  completed: "bg-emerald-400/15 text-emerald-400 border-emerald-400/30",
  failed:    "bg-red-400/15 text-red-400 border-red-400/30",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-[var(--border)] text-[var(--muted)]";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

function short(id: string | null): string {
  if (!id) return "—";
  return id.slice(0, 8) + "…";
}

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

const FILTERS = ["all", "pending", "running", "failed", "completed"] as const;
type Filter = (typeof FILTERS)[number];

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [workerHint, setWorkerHint] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const qs = filter !== "all" ? `?status=${filter}` : "";
    const r = await api<{ tasks: Task[] }>(`/tasks${qs}`);
    setTasks(r.tasks ?? []);
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => void load(), 4000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, load]);

  useEffect(() => {
    let cancelled = false;
    async function pollDiag() {
      if (!(await getValidAccessToken())) return;
      try {
        const r = await api<{
          tasks?: { pending_scheduled_ready?: number };
          worker?: { seems_running?: boolean };
          warnings?: string[];
        }>("/debug/diagnostics");
        if (cancelled) return;
        const pend = r.tasks?.pending_scheduled_ready ?? 0;
        const up = r.worker?.seems_running ?? false;
        if (pend > 0 && !up) {
          const line = r.warnings?.find((x) => /pendientes|tareas listas|latido|worker/i.test(x));
          setWorkerHint(
            line ??
              "Hay tareas listas pero no se detecta el worker. Desde la raíz del repo ejecuta npm run dev:worker o npm run dev (API + worker + frontend). Solo npm run dev:frontend no procesa la cola."
          );
        } else setWorkerHint(null);
      } catch {
        if (!cancelled) setWorkerHint(null);
      }
    }
    void pollDiag();
    const id = setInterval(pollDiag, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const skipDelay = useCallback(async (id: string) => {
    setSkipping(id);
    try {
      await api(`/tasks/${id}/skip-delay`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } finally {
      setSkipping(null);
    }
  }, [load]);

  const deleteOne = useCallback(async (id: string) => {
    setDeleting(id);
    try {
      await api(`/tasks/${id}`, { method: "DELETE" });
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } finally {
      setDeleting(null);
    }
  }, []);

  const deleteByStatus = useCallback(async (status: string) => {
    setBulkStatus(status);
    try {
      const r = await api<{ deleted: number }>("/tasks", {
        method: "DELETE",
        body: JSON.stringify({ status }),
      });
      setBulkStatus(null);
      await load();
      return r.deleted;
    } catch {
      setBulkStatus(null);
    }
  }, [load]);

  const counts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">Cola de tareas</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="btn-secondary py-1.5 text-xs"
          >
            ↺ Refrescar
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--accent)]"
            />
            Auto (4s)
          </label>
        </div>
      </div>

      {workerHint ? (
        <div
          role="status"
          className="rounded-[var(--radius-md)] border border-amber-500/45 bg-amber-500/10 px-3 py-2.5 text-sm leading-snug text-amber-100"
        >
          <span className="font-semibold text-amber-50">Worker de automatización: </span>
          {workerHint}
        </div>
      ) : null}

      {/* Counters */}
      <div className="flex flex-wrap gap-2">
        {(["pending", "running", "failed", "completed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`rounded-[var(--radius-md)] border px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === s
                ? STATUS_STYLES[s] ?? "bg-[var(--border)]"
                : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--text)]/20"
            }`}
          >
            {s} {counts[s] ? <span className="font-bold">({counts[s]})</span> : "(0)"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-[var(--radius-md)] border px-2.5 py-1 text-xs font-medium transition-colors ${
            filter === "all"
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--text)]/20"
          }`}
        >
          todas ({tasks.length})
        </button>
      </div>

      {/* Bulk actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={bulkStatus === "failed"}
          onClick={() => void deleteByStatus("failed")}
          className="rounded-[var(--radius-md)] border border-red-500/30 bg-red-500/5 px-2.5 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          {bulkStatus === "failed" ? "Eliminando…" : "Borrar todas las fallidas"}
        </button>
        <button
          type="button"
          disabled={bulkStatus === "completed"}
          onClick={() => void deleteByStatus("completed")}
          className="rounded-[var(--radius-md)] border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:border-[var(--text)]/20 disabled:opacity-50"
        >
          {bulkStatus === "completed" ? "Eliminando…" : "Borrar completadas"}
        </button>
        <button
          type="button"
          disabled={bulkStatus === "all"}
          onClick={() => {
            if (!confirm("¿Borrar TODAS las tareas (pending, running, failed, completed)? Esta acción no se puede deshacer.")) return;
            void deleteByStatus("all");
          }}
          className="rounded-[var(--radius-md)] border border-red-600/40 bg-red-600/10 px-2.5 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-600/20 disabled:opacity-50"
        >
          {bulkStatus === "all" ? "Eliminando…" : "⚠ Borrar TODAS"}
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]">
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Acción</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Estado</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Cuenta</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Lead</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Espera</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Creada</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]">Int.</th>
              <th className="px-3 py-2 text-left font-semibold text-[var(--muted)]"></th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--muted)]">
                  Sin tareas
                </td>
              </tr>
            )}
            {tasks.map((t) => (
              <>
                <tr
                  key={t.id}
                  className="border-b border-[var(--border)]/50 bg-[color-mix(in_srgb,var(--surface)_32%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]"
                >
                  <td className="px-3 py-2 font-mono font-semibold text-[var(--text)]">{t.action}</td>
                  <td className="px-3 py-2">
                    {isWaiting(t) ? (
                      <span className="inline-flex items-center rounded border border-purple-400/30 bg-purple-400/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-purple-400">
                        esperando
                      </span>
                    ) : (
                      <StatusBadge status={t.status} />
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--muted)]">{short(t.account_id)}</td>
                  <td className="px-3 py-2 font-mono text-[var(--muted)]">{short(t.lead_id)}</td>
                  <td className="px-3 py-2 font-mono text-[var(--muted)]" title={t.scheduled_at}>
                    {isWaiting(t) ? (
                      <span className="text-purple-400">en {timeUntil(t.scheduled_at)}</span>
                    ) : (
                      relativeTime(t.scheduled_at)
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[var(--muted)]" title={t.created_at}>
                    {relativeTime(t.created_at)}
                  </td>
                  <td className="px-3 py-2 text-center text-[var(--muted)]">{t.attempts}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {isWaiting(t) && (
                        <button
                          type="button"
                          disabled={skipping === t.id}
                          onClick={() => void skipDelay(t.id)}
                          className="rounded border border-purple-400/30 bg-purple-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-purple-400 hover:bg-purple-400/20 disabled:opacity-40"
                          title="Ejecutar ahora (ignorar espera)"
                        >
                          {skipping === t.id ? "…" : "▶ Skip"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => (prev === t.id ? null : t.id))}
                        className="rounded px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] hover:text-[var(--text)]"
                      >
                        {expanded === t.id ? "▲" : "▼"}
                      </button>
                      <button
                        type="button"
                        disabled={deleting === t.id}
                        onClick={() => void deleteOne(t.id)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-red-400/70 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr key={`${t.id}-exp`} className="border-b border-[var(--border)]/50 bg-[color-mix(in_srgb,var(--text)_2%,transparent)]">
                    <td colSpan={8} className="px-3 py-2">
                      {t.error_message && (
                        <p className="mb-1.5 rounded bg-red-500/10 px-2 py-1 text-[10px] font-mono text-red-400">
                          Error: {t.error_message}
                        </p>
                      )}
                      <div className="grid gap-1 font-mono text-[10px] text-[var(--muted)] sm:grid-cols-2">
                        <span>ID: {t.id}</span>
                        {t.enrollment_id && <span>Enrollment: {t.enrollment_id}</span>}
                        <span>Scheduled: {new Date(t.scheduled_at).toLocaleString()}</span>
                        <span>Created: {new Date(t.created_at).toLocaleString()}</span>
                      </div>
                      {t.payload && Object.keys(t.payload).length > 0 && (
                        <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-black/30 p-2 text-[10px] leading-relaxed text-[var(--muted)]">
                          {JSON.stringify(t.payload, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
