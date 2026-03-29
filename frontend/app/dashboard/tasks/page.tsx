"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Task = {
  id: string;
  action: string;
  status: string;
  scheduled_at: string;
  error_message: string | null;
  attempts: number;
};

type Diagnostics = Record<string, unknown>;

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagErr, setDiagErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ tasks: Task[] }>("/tasks");
    setTasks(r.tasks);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const runDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    setDiagErr(null);
    try {
      if (!(await getValidAccessToken())) {
        setDiagErr("Sin sesión");
        return;
      }
      const r = await api<Diagnostics>("/debug/diagnostics");
      setDiag(r);
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagLoading(false);
    }
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Cola de tareas</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runDiagnostics}
          disabled={diagLoading}
          className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
        >
          {diagLoading ? "Analizando…" : "Diagnóstico del stack"}
        </button>
        {diagErr && <span className="text-sm text-red-400">{diagErr}</span>}
      </div>
      {diag && (
        <div className="mb-6 rounded border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-2 text-sm font-medium text-amber-200/90">Resultado (API + Supabase)</p>
          {Array.isArray(diag.warnings) && (diag.warnings as string[]).length > 0 && (
            <ul className="mb-3 list-inside list-disc text-sm text-amber-100/90">
              {(diag.warnings as string[]).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <pre className="max-h-80 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-[var(--muted)]">
            {JSON.stringify(diag, null, 2)}
          </pre>
        </div>
      )}
      <p className="mb-4 max-w-2xl text-sm text-[var(--muted)]">
        Estado en Supabase. Si una tarea se queda en «running» tras cerrar el worker, el propio worker la vuelve a
        «pending» pasados unos minutos (migración <code className="text-[var(--text)]">003_tasks_locked_at</code> +
        variable <code className="text-[var(--text)]">TASK_STALE_RUNNING_MINUTES</code> en el backend).
      </p>
      <ul className="space-y-2 font-mono text-xs">
        {tasks.map((t) => (
          <li key={t.id} className="rounded border border-white/10 px-2 py-2">
            <div className="flex flex-wrap justify-between gap-2">
              <span>{t.action}</span>
              <span className="text-[var(--muted)]">{t.status}</span>
            </div>
            <div className="text-[var(--muted)]">{t.scheduled_at}</div>
            {t.error_message && <div className="text-red-400">{t.error_message}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
