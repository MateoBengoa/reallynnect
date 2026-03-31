"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import { LeadAvatar } from "./LeadAvatar";
import type { CrmStatus, EnrollmentRow, LeadRow } from "./leadTypes";
import { CRM_LABELS } from "./leadTypes";

type LeadDetailDrawerProps = {
  open: boolean;
  onClose: () => void;
  lead: LeadRow | null;
  enrollment?: EnrollmentRow | null;
  campaignId?: string;
  onUpdated?: () => void;
  /** Tras encolar sync de foto, recargar leads/inscripciones para refrescar `photo_url`. */
  onRefreshLeads?: () => void | Promise<void>;
};

const CRM_OPTIONS = Object.keys(CRM_LABELS) as CrmStatus[];

export function LeadDetailDrawer({ open, onClose, lead, enrollment, campaignId, onUpdated, onRefreshLeads }: LeadDetailDrawerProps) {
  const [saving, setSaving] = useState(false);
  const [crm, setCrm] = useState<CrmStatus | "">("");

  let extraData: Record<string, string | number | boolean> | null = null;
  try {
    if (lead?.notes?.startsWith("{")) {
      extraData = JSON.parse(lead.notes);
    }
  } catch {}

  useEffect(() => {
    if (enrollment) setCrm(enrollment.crm_status);
    else setCrm("");
  }, [enrollment, open]);

  const patchCrm = useCallback(
    async (next: CrmStatus) => {
      if (!enrollment || !campaignId) return;
      setSaving(true);
      try {
        if (!(await getValidAccessToken())) return;
        await api(`/campaigns/${campaignId}/enrollments/${enrollment.id}`, {
          method: "PATCH",
          body: JSON.stringify({ crm_status: next }),
        });
        setCrm(next);
        onUpdated?.();
      } catch (e) {
        console.error(e);
        alert(e instanceof Error ? e.message : "Error al guardar");
      } finally {
        setSaving(false);
      }
    },
    [enrollment, campaignId, onUpdated]
  );

  if (!open || !lead) return null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" aria-label="Cerrar" onClick={onClose} />
      <aside
        className="popover-panel relative flex h-full w-full max-w-md flex-col border-l border-[var(--border)] sm:rounded-l-[var(--radius-lg)]"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--border)] p-4">
          <div className="flex min-w-0 gap-3">
            <LeadAvatar lead={lead} size="md" />
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-[var(--text)]">{lead.name ?? "Sin nombre"}</h2>
              {lead.headline && <p className="mt-0.5 text-sm text-[var(--muted)]">{lead.headline}</p>}
            </div>
          </div>
          <button type="button" className="btn-ghost min-h-9 px-2" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {enrollment && campaignId && (
            <label className="block">
              <span className="text-xs font-medium text-[var(--muted)]">Estado CRM (esta campaña)</span>
              <select
                className="input-field mt-1 min-h-[2.5rem] py-2"
                value={crm || enrollment.crm_status}
                disabled={saving}
                onChange={(e) => patchCrm(e.target.value as CrmStatus)}
              >
                {CRM_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {CRM_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          )}

          <dl className="space-y-3">
            <Row label="URL perfil" value={lead.profile_url} link />
            {lead.location && <Row label="Ubicación" value={lead.location} />}
            {lead.company && <Row label="Empresa" value={lead.company} />}
            {lead.title && <Row label="Puesto" value={lead.title} />}
            {lead.website && <Row label="Web" value={lead.website} link />}
            {lead.email && <Row label="Email" value={lead.email} />}
            {lead.phone && <Row label="Teléfono" value={lead.phone} />}
            {lead.source && <Row label="Origen" value={lead.source} />}
            {extraData &&
              Object.entries(extraData).map(([k, v]) => (
                <Row key={k} label={k} value={String(v)} />
              ))}
          </dl>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="mt-0.5 break-all text-[var(--text)]">
        {link ? (
          <a href={value} target="_blank" rel="noreferrer" className="link-focus rounded-sm text-[var(--accent)] underline-offset-2 hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
