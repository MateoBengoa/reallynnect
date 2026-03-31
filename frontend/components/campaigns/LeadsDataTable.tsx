"use client";

import { LeadAvatar } from "./LeadAvatar";
import type { CrmStatus, EnrollmentRow, LeadRow } from "./leadTypes";
import { CRM_LABELS } from "./leadTypes";

type LeadsDataTableProps = {
  rows: { lead: LeadRow; enrollment?: EnrollmentRow }[];
  onRowClick: (lead: LeadRow, enrollment?: EnrollmentRow) => void;
  showCrmColumn?: boolean;
};

export function LeadsDataTable({ rows, onRowClick, showCrmColumn }: LeadsDataTableProps) {
  if (!rows.length) {
    return (
      <div className="card card-pad py-14 text-center">
        <p className="text-sm text-[var(--muted)]">No hay leads.</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,var(--bg))] backdrop-blur-sm">
            <tr className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <th className="w-12 px-4 py-3.5" aria-hidden />
              <th className="px-3 py-3.5 font-medium">Nombre</th>
              <th className="px-3 py-3.5 font-medium">Headline / título</th>
              <th className="px-3 py-3.5 font-medium">Empresa</th>
              {showCrmColumn && <th className="px-3 py-3.5 font-medium">Estado</th>}
              <th className="px-3 py-3.5 font-medium">Ubicación</th>
              <th className="px-4 py-3.5 font-medium">Perfil</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ lead, enrollment }) => (
              <tr
                key={enrollment?.id ?? lead.id}
                className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))]"
                onClick={() => onRowClick(lead, enrollment)}
              >
                <td className="px-4 py-3">
                  <LeadAvatar lead={lead} size="sm" />
                </td>
                <td className="px-3 py-3 font-medium text-[var(--text)]">{lead.name ?? "—"}</td>
                <td className="max-w-[220px] px-3 py-3">
                  <span className="line-clamp-2 text-[var(--muted)]" title={lead.headline ?? lead.title ?? undefined}>
                    {lead.headline ?? lead.title ?? "—"}
                  </span>
                </td>
                <td className="max-w-[140px] truncate px-3 py-3 text-[var(--muted)]">{lead.company ?? "—"}</td>
                {showCrmColumn && (
                  <td className="px-3 py-3">
                    <span className="inline-flex rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                      {enrollment
                        ? (CRM_LABELS[enrollment.crm_status as CrmStatus] ?? enrollment.crm_status)
                        : "—"}
                    </span>
                  </td>
                )}
                <td className="max-w-[120px] truncate px-3 py-3 text-[var(--muted)]">{lead.location ?? "—"}</td>
                <td className="px-4 py-3">
                  <a
                    href={lead.profile_url}
                    target="_blank"
                    rel="noreferrer"
                    className="link-focus font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Abrir
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
