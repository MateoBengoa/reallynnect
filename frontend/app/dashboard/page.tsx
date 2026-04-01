"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type PipelineKey = "not_contacted" | "in_campaign" | "contacted" | "replied" | "not_accepted" | "blacklist";

type CrmSummary = {
  pipeline: Record<PipelineKey, number>;
  recent_replied: { lead_id: string; name: string | null; photo_url: string | null; title: string | null; company: string | null }[];
  campaigns_active: { id: string; name: string; status: string }[];
  task_counts: Record<string, number>;
  recent_conversations: { id: string; peer_name: string | null; peer_photo_url: string | null; list_preview: string | null; list_last_activity_at: string | null }[];
  total_leads: number;
  accounts_active: number;
};

const PIPELINE: { key: PipelineKey; label: string; color: string; bg: string }[] = [
  { key: "not_contacted", label: "Sin contactar",  color: "text-[var(--muted)]",  bg: "bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))]" },
  { key: "in_campaign",   label: "En campaña",     color: "text-[var(--accent)]", bg: "bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))]" },
  { key: "contacted",     label: "Contactado",      color: "text-sky-400",         bg: "bg-sky-400/10" },
  { key: "replied",       label: "Respondió",       color: "text-emerald-400",     bg: "bg-emerald-400/10" },
  { key: "not_accepted",  label: "No aceptó",       color: "text-amber-400",       bg: "bg-amber-400/10" },
  { key: "blacklist",     label: "Blacklist",        color: "text-red-400",         bg: "bg-red-400/10" },
];

function Avatar({ name, photo, size = 8 }: { name: string | null; photo: string | null; size?: number }) {
  const initial = (name ?? "?").charAt(0).toUpperCase();
  const cls = `h-${size} w-${size} shrink-0 rounded-full object-cover`;
  if (photo) return <img src={photo} alt={name ?? ""} className={cls} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />;
  return (
    <div className={`flex h-${size} w-${size} shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface))] text-xs font-bold text-[var(--accent)]`}>
      {initial}
    </div>
  );
}

function relTime(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function DashboardHome() {
  const [data, setData] = useState<CrmSummary | null>(null);

  useEffect(() => {
    (async () => {
      if (!(await getValidAccessToken())) return;
      try {
        const r = await api<CrmSummary>("/crm-summary");
        setData(r);
      } catch { /* ignore */ }
    })();
  }, []);

  const pipeline = data?.pipeline ?? {} as Record<PipelineKey, number>;
  const totalPipeline = PIPELINE.reduce((s, p) => s + (pipeline[p.key] ?? 0), 0);

  return (
    <div className="space-y-6">
      <h1 className="page-title">CRM</h1>

      {/* ── KPIs ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="kpi-card">
          <p className="text-xs text-[var(--muted)]">Leads totales</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{data?.total_leads ?? "—"}</p>
        </div>
        <div className="kpi-card">
          <p className="text-xs text-[var(--muted)]">En pipeline</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{totalPipeline || "—"}</p>
        </div>
        <div className="kpi-card">
          <p className="text-xs text-[var(--muted)]">Campañas activas</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-[var(--accent)]">{data?.campaigns_active.length ?? "—"}</p>
        </div>
        <div className="kpi-card">
          <p className="text-xs text-[var(--muted)]">Cuentas conectadas</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-emerald-400">{data?.accounts_active ?? "—"}</p>
        </div>
      </div>

      {/* ── Pipeline kanban ── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">Pipeline CRM</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {PIPELINE.map(({ key, label, color, bg }) => {
            const n = pipeline[key] ?? 0;
            const pct = totalPipeline > 0 ? Math.round((n / totalPipeline) * 100) : 0;
            return (
              <Link
                key={key}
                href="/dashboard/campaigns"
                className={`group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] p-4 transition-colors hover:border-[color-mix(in_srgb,var(--text)_20%,var(--border))] ${bg}`}
              >
                <span className={`text-xs font-semibold ${color}`}>{label}</span>
                <span className="text-2xl font-bold text-[var(--text)]">{n}</span>
                {totalPipeline > 0 && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text)_10%,transparent)]">
                    <div className="h-full rounded-full bg-current transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
                <span className="text-[10px] text-[var(--muted)]">{pct}% del total</span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ── Fila inferior: Respondieron + Actividad + Campañas ── */}
      <div className="grid gap-4 lg:grid-cols-3">

        {/* Leads que respondieron */}
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--text)]">Respondieron</h2>
            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
              {pipeline.replied ?? 0}
            </span>
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {(data?.recent_replied ?? []).length === 0 && (
              <li className="px-4 py-6 text-center text-xs text-[var(--muted)]">Ninguno aún</li>
            )}
            {(data?.recent_replied ?? []).map((l) => (
              <li key={l.lead_id} className="flex items-center gap-3 px-4 py-3 hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))]">
                <Avatar name={l.name} photo={l.photo_url} size={8} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--text)]">{l.name ?? "Lead"}</p>
                  <p className="truncate text-[11px] text-[var(--muted)]">{l.title ?? l.company ?? "—"}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Conversaciones recientes */}
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--text)]">Actividad reciente</h2>
            <Link href="/dashboard/inbox" className="text-[11px] text-[var(--accent)] hover:underline">Ver inbox →</Link>
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {(data?.recent_conversations ?? []).length === 0 && (
              <li className="px-4 py-6 text-center text-xs text-[var(--muted)]">Sin mensajes aún</li>
            )}
            {(data?.recent_conversations ?? []).map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-4 py-3 hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))]">
                <Avatar name={m.peer_name} photo={m.peer_photo_url} size={7} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <p className="truncate text-xs font-medium text-[var(--text)]">{m.peer_name ?? "—"}</p>
                    {m.list_last_activity_at && (
                      <span className="shrink-0 text-[10px] text-[var(--muted)]">{relTime(m.list_last_activity_at)}</span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-[var(--muted)]">{m.list_preview ?? "—"}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Campañas activas + tareas */}
        <section className="flex flex-col gap-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-sm font-semibold text-[var(--text)]">Campañas activas</h2>
              <Link href="/dashboard/campaigns" className="text-[11px] text-[var(--accent)] hover:underline">Ver todas →</Link>
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {(data?.campaigns_active ?? []).length === 0 && (
                <li className="px-4 py-6 text-center text-xs text-[var(--muted)]">Sin campañas activas</li>
              )}
              {(data?.campaigns_active ?? []).map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))]">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                  <p className="truncate text-sm text-[var(--text)]">{c.name}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Worker status */}
          <div className="card px-4 py-4">
            <h2 className="mb-3 text-sm font-semibold text-[var(--text)]">Worker</h2>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Pendientes", key: "pending", color: "text-amber-400" },
                { label: "Running",    key: "running",  color: "text-sky-400" },
                { label: "Completadas",key: "completed",color: "text-emerald-400" },
                { label: "Fallidas",   key: "dead",     color: "text-red-400" },
              ].map(({ label, key, color }) => (
                <div key={key} className="rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2">
                  <p className="text-[10px] text-[var(--muted)]">{label}</p>
                  <p className={`text-lg font-semibold ${color}`}>{data?.task_counts[key] ?? "—"}</p>
                </div>
              ))}
            </div>
            <Link href="/dashboard/tasks" className="mt-3 block text-center text-[11px] text-[var(--accent)] hover:underline">
              Ver cola de tareas →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
