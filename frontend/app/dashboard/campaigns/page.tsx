"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Campaign = { id: string; name: string; status: string };

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active:   { label: "Activa",    cls: "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)]" },
  paused:   { label: "Pausada",   cls: "border-[color-mix(in_srgb,#f59e0b_40%,var(--border))] bg-[color-mix(in_srgb,#f59e0b_12%,var(--surface))] text-amber-400" },
  draft:    { label: "Borrador",  cls: "border-[color-mix(in_srgb,var(--muted)_40%,var(--border))] bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))] text-[var(--muted)]" },
  completed:{ label: "Completa",  cls: "border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_12%,var(--surface))] text-[#86efac]" },
  archived: { label: "Archivada", cls: "border-[color-mix(in_srgb,var(--muted)_30%,var(--border))] bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))] text-[var(--muted)]" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, cls: "border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))] text-[var(--muted)]" };
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${m.cls}`}>
      {m.label}
    </span>
  );
}

function CampaignInitial({ name }: { name: string }) {
  const initial = (name ?? "C").charAt(0).toUpperCase();
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,var(--surface))] text-base font-bold text-[var(--accent)] ring-1 ring-[var(--border)]">
      {initial}
    </div>
  );
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ campaigns: Campaign[] }>("/campaigns");
    setCampaigns(r.campaigns);
  }, []);

  useEffect(() => { load(); }, [load]);

  function openWizard() {
    setName("");
    setError(null);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setError(null);
  }

  async function create() {
    if (!name.trim()) { setError("Ingresá un nombre para la campaña."); return; }
    setSaving(true);
    setError(null);
    try {
      if (!(await getValidAccessToken())) return;
      await api("/campaigns", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await load();
      closeWizard();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0">
      <header className="mb-6">
        <h1 className="page-title mb-1">Campañas</h1>
        <p className="page-desc">Crea una campaña y ábrela para gestionar leads, el flujo, analíticas y horarios.</p>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {/* Botón crear */}
        <button
          type="button"
          onClick={openWizard}
          className="group flex min-h-[12rem] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_38%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-4 py-8 text-center transition-[border-color,background-color] hover:border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)] transition-transform group-hover:scale-105" aria-hidden>
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </span>
          <span className="text-base font-semibold text-[var(--text)]">Crear campaña</span>
          <span className="max-w-[15rem] text-xs leading-snug text-[var(--muted)]">Configurá el flujo, los leads y el horario de envío.</span>
        </button>

        {campaigns.map((c) => (
          <article key={c.id} className="card flex flex-col overflow-hidden shadow-[var(--shadow-sm)]">
            {/* Header */}
            <div className="flex items-start gap-3 px-4 pt-4">
              <CampaignInitial name={c.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-[var(--text)]">{c.name}</span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--muted)]">Campaña de outreach</p>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-auto flex gap-2 px-4 pb-4 pt-4">
              <Link
                href={`/dashboard/campaigns/${c.id}?tab=leads`}
                className="btn-primary min-h-8 flex-1 text-center text-xs"
              >
                Abrir campaña →
              </Link>
              <Link
                href={`/dashboard/campaigns/${c.id}?tab=workflow`}
                className="btn-secondary min-h-8 text-xs"
              >
                Flujo
              </Link>
            </div>
          </article>
        ))}
      </div>

      {campaigns.length === 0 && (
        <p className="mt-4 text-sm text-[var(--muted)]">Aún no hay campañas. Usá «Crear campaña» para empezar.</p>
      )}

      {/* Modal crear campaña */}
      {wizardOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="campaign-wizard-title"
          onClick={(e) => { if (e.target === e.currentTarget) closeWizard(); }}
        >
          <div className="popover-panel flex w-full max-w-md flex-col overflow-hidden shadow-[var(--shadow-md)]">
            {/* Header */}
            <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Nueva campaña</p>
                  <h2 id="campaign-wizard-title" className="mt-1 text-lg font-semibold text-[var(--text)]">¿Cómo se llama?</h2>
                </div>
                <button type="button" className="btn-ghost min-h-9 px-2 text-sm" onClick={closeWizard}>Cerrar</button>
              </div>
            </div>

            {/* Body */}
            <div className="px-5 py-5">
              {error && (
                <p className="mb-4 rounded-md border border-[color-mix(in_srgb,#f87171_40%,var(--border))] bg-[color-mix(in_srgb,#ef4444_10%,var(--surface))] px-3 py-2 text-sm text-[#fca5a5]">
                  {error}
                </p>
              )}
              <label className="block">
                <span className="mb-2 block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                  Nombre de la campaña
                </span>
                <input
                  className="input-field text-sm"
                  placeholder="Ej. Outbound Q2 · SaaS founders"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
                  autoFocus
                />
              </label>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-5 py-3">
              <button type="button" className="btn-secondary min-h-10" onClick={closeWizard}>Cancelar</button>
              <button type="button" className="btn-primary min-h-10" onClick={() => void create()} disabled={saving}>
                {saving ? "Creando…" : "Crear campaña"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
