"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { WorkflowStep } from "@/components/CampaignWorkflowEditor";

const CampaignWorkflowEditor = dynamic(
  () => import("@/components/CampaignWorkflowEditor").then((m) => ({ default: m.CampaignWorkflowEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[360px] animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" aria-hidden />
    ),
  }
);

type Campaign = { id: string; name: string; status: string };

const STEP_TYPES = [
  "visit_profile",
  "connect",
  "send_message",
  "send_message_open_profile",
  "follow",
  "like_post",
  "comment_post",
  "voice_note",
  "reply_comment",
  "inmail",
] as const;

const DEFAULT_STEPS: WorkflowStep[] = [
  { step_type: "visit_profile", delay_hours: 0, message_template: "Hola {name}" },
  { step_type: "connect", delay_hours: 48, message_template: "" },
];

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<WorkflowStep[]>(DEFAULT_STEPS);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ campaigns: Campaign[] }>("/campaigns");
    setCampaigns(r.campaigns);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function loadSteps(id: string) {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ steps: WorkflowStep[] }>(`/campaigns/${id}/steps`);
    setSteps(r.steps?.length ? r.steps : DEFAULT_STEPS);
    setSelected(id);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    await api("/campaigns", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await load();
  }

  function stepsPayload() {
    return steps.map((s) => ({
      step_type: s.step_type,
      delay_hours: s.delay_hours,
      message_template: s.message_template || undefined,
    }));
  }

  async function saveSteps() {
    if (!selected) return;
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${selected}/steps`, {
      method: "PUT",
      body: JSON.stringify({ steps: stepsPayload() }),
    });
    alert("Pasos guardados");
  }

  async function start() {
    if (!selected) return;
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${selected}/steps`, {
      method: "PUT",
      body: JSON.stringify({ steps: stepsPayload() }),
    });
    const r = await api<{
      leads: number;
      tasks_scheduled: number;
      enrollments_new: number;
      enrollments_existing: number;
    }>(`/campaigns/${selected}/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    alert(
      `Campaña iniciada. Leads: ${r.leads}. Tareas encoladas ahora: ${r.tasks_scheduled}. ` +
        `(Inscripciones nuevas: ${r.enrollments_new}, ya existentes: ${r.enrollments_existing}). Revisa «Tareas» en unos segundos.`
    );
    await load();
  }

  async function pause() {
    if (!selected) return;
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${selected}/pause`, { method: "POST", body: JSON.stringify({}) });
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Campañas</h1>
      <p className="mb-4 max-w-2xl text-sm text-[var(--muted)]">
        Diseña el flujo como secuencia de bloques. Arrastra para reordenar; el backend ejecuta los pasos en orden fijo
        (sin ramas «si responde» en esta versión).
      </p>
      <form onSubmit={create} className="mb-6 flex max-w-md gap-2">
        <input
          className="flex-1 rounded border border-white/10 bg-[var(--surface)] px-2 py-1.5"
          placeholder="Nombre campaña"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white">
          Crear
        </button>
      </form>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <ul className="shrink-0 space-y-1 lg:w-56">
          {campaigns.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`w-full rounded border px-2 py-2 text-left text-sm ${selected === c.id ? "border-[var(--accent)]" : "border-white/10"}`}
                onClick={() => loadSteps(c.id)}
              >
                {c.name} <span className="text-[var(--muted)]">({c.status})</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 space-y-3">
          <CampaignWorkflowEditor steps={steps} setSteps={setSteps} stepTypes={STEP_TYPES} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-lg bg-white/10 px-3 py-1.5 text-sm" onClick={saveSteps} disabled={!selected}>
              Guardar pasos
            </button>
            <button type="button" className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white" onClick={start} disabled={!selected}>
              Iniciar
            </button>
            <button type="button" className="rounded-lg border border-white/20 px-3 py-1.5 text-sm" onClick={pause} disabled={!selected}>
              Pausar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
