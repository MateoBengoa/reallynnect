"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import { startLeadPhotoPoll } from "@/lib/leadPhotoPoll";
import { ImportContactsModal } from "@/components/campaigns/ImportContactsModal";
import { LeadDetailDrawer } from "@/components/campaigns/LeadDetailDrawer";
import { LeadsDataTable } from "@/components/campaigns/LeadsDataTable";
import type { LeadRow } from "@/components/campaigns/leadTypes";

export function LeadsClient() {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const stopPhotoPoll = useRef<(() => void) | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [drawerLead, setDrawerLead] = useState<LeadRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async (opts?: { batchSyncPhotos?: boolean }) => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ leads: LeadRow[] }>("/leads");
    setLeads(r.leads ?? []);
    if (opts?.batchSyncPhotos) {
      /* Primero intentar fotos públicas (Microlink / og:image / unavatar) — no requiere cuenta LI */
      try {
        const fetchRes = await api<{ updated: number; attempted: number }>("/leads/fetch-photos", {
          method: "POST",
          body: JSON.stringify({ max: 60, concurrency: 4 }),
        });
        if (fetchRes.updated > 0) {
          const r1 = await api<{ leads: LeadRow[] }>("/leads");
          setLeads(r1.leads ?? []);
        }
      } catch {
        /* fetch-photos falló; seguimos con batch-sync */
      }
      /* Luego intentar con worker LinkedIn (requiere cuenta activa) */
      try {
        stopPhotoPoll.current?.();
        stopPhotoPoll.current = null;
        const syncRes = await api<{ ok: boolean; task_id: string | null; queued: number }>("/leads/batch-sync-photos", {
          method: "POST",
          body: JSON.stringify({ max: 45 }),
        });
        if (syncRes.queued > 0) {
          stopPhotoPoll.current = startLeadPhotoPoll(async () => {
            const r2 = await api<{ leads: LeadRow[] }>("/leads");
            setLeads(r2.leads ?? []);
            return r2.leads ?? [];
          });
        }
      } catch {
        /* Sin cuenta LinkedIn activa o cola; las fotos se rellenan cuando el worker ejecute el lote */
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      stopPhotoPoll.current?.();
      stopPhotoPoll.current = null;
    };
  }, []);

  useEffect(() => {
    const id = drawerLead?.id;
    if (!id) return;
    const next = leads.find((l) => l.id === id);
    if (next) setDrawerLead(next);
  }, [leads, drawerLead?.id]);

  const rows = leads.map((lead) => ({ lead }));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">Leads</h1>
        <button type="button" className="btn-primary" onClick={() => setImportOpen(true)}>
          Importar contactos
        </button>
      </div>
      <p className="page-desc mb-6">
        Todos tus contactos importados. El estado CRM detallado se gestiona dentro de cada campaña.
      </p>

      <LeadsDataTable
        showCrmColumn={false}
        rows={rows}
        onRowClick={(lead) => {
          setDrawerLead(lead);
          setDrawerOpen(true);
        }}
      />

      <ImportContactsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => void load({ batchSyncPhotos: true })}
      />
      <LeadDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        lead={drawerLead}
        onRefreshLeads={() => load()}
      />
    </div>
  );
}
