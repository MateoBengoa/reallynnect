"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Campaign = { id: string; name: string; status: string };

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ campaigns: Campaign[] }>("/campaigns");
    setCampaigns(r.campaigns);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    await api("/campaigns", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await load();
  }

  return (
    <div>
      <h1 className="page-title">Campañas</h1>
      <p className="page-desc mt-2 mb-8">
        Crea una campaña y ábrela para gestionar leads, el flujo tipo n8n, analíticas y ajustes de horario y límites.
      </p>

      <form
        id="nueva-campana"
        onSubmit={create}
        className="card card-pad mb-10 flex max-w-xl scroll-mt-28 flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor="new-campaign-name" className="text-xs font-medium text-[var(--muted)]">
            Nombre de la campaña
          </label>
          <input
            id="new-campaign-name"
            className="input-field"
            placeholder="Ej. Outbound Q2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary shrink-0">
          Crear campaña
        </button>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {campaigns.map((c) => (
          <Link
            key={c.id}
            href={`/dashboard/campaigns/${c.id}?tab=leads`}
            className="link-focus kpi-card group block transition-transform hover:-translate-y-0.5"
          >
            <p className="font-semibold text-[var(--text)]">{c.name}</p>
            <p className="mt-1.5 inline-flex rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              {c.status}
            </p>
            <p className="mt-4 text-sm font-medium text-[var(--accent)]">Abrir detalle →</p>
          </Link>
        ))}
      </div>
      {!campaigns.length && <p className="page-desc py-8 text-center">Aún no hay campañas.</p>}
    </div>
  );
}
