"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";

type Campaign = { id: string; name: string; status: string };
type Step = {
  id?: string;
  step_type: string;
  delay_hours: number;
  message_template: string | null;
};

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

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([
    { step_type: "visit_profile", delay_hours: 0, message_template: "Hola {name}" },
    { step_type: "connect", delay_hours: 48, message_template: "" },
  ]);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ campaigns: Campaign[] }>("/campaigns", token);
    setCampaigns(r.campaigns);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function loadSteps(id: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ steps: Step[] }>(`/campaigns/${id}/steps`, token);
    if (r.steps?.length) setSteps(r.steps);
    setSelected(id);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api("/campaigns", token, { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await load();
  }

  async function saveSteps() {
    if (!selected) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api(`/campaigns/${selected}/steps`, token, {
      method: "PUT",
      body: JSON.stringify({
        steps: steps.map((s) => ({
          step_type: s.step_type,
          delay_hours: s.delay_hours,
          message_template: s.message_template || undefined,
        })),
      }),
    });
    alert("Pasos guardados");
  }

  async function start() {
    if (!selected) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api(`/campaigns/${selected}/steps`, token, {
      method: "PUT",
      body: JSON.stringify({
        steps: steps.map((s) => ({
          step_type: s.step_type,
          delay_hours: s.delay_hours,
          message_template: s.message_template || undefined,
        })),
      }),
    });
    const r = await api<{
      leads: number;
      tasks_scheduled: number;
      enrollments_new: number;
      enrollments_existing: number;
    }>(`/campaigns/${selected}/start`, token, {
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
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api(`/campaigns/${selected}/pause`, token, { method: "POST", body: JSON.stringify({}) });
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Campañas</h1>
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
      <div className="grid gap-6 lg:grid-cols-2">
        <ul className="space-y-1">
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
        <div className="rounded-xl border border-white/10 bg-[var(--surface)] p-4">
          <p className="mb-2 text-sm text-[var(--muted)]">Pasos (orden = secuencia)</p>
          {steps.map((s, i) => (
            <div key={i} className="mb-3 grid gap-2 border-b border-white/5 pb-3 sm:grid-cols-2">
              <select
                className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1 text-sm"
                value={s.step_type}
                onChange={(e) => {
                  const n = [...steps];
                  n[i] = { ...n[i], step_type: e.target.value };
                  setSteps(n);
                }}
              >
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1 text-sm"
                value={s.delay_hours}
                onChange={(e) => {
                  const n = [...steps];
                  n[i] = { ...n[i], delay_hours: Number(e.target.value) };
                  setSteps(n);
                }}
              />
              <input
                className="sm:col-span-2 rounded border border-white/10 bg-[var(--bg)] px-2 py-1 text-xs"
                placeholder="Plantilla mensaje ({name})"
                value={s.message_template ?? ""}
                onChange={(e) => {
                  const n = [...steps];
                  n[i] = { ...n[i], message_template: e.target.value };
                  setSteps(n);
                }}
              />
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="rounded bg-white/10 px-3 py-1.5 text-sm" onClick={saveSteps} disabled={!selected}>
              Guardar pasos
            </button>
            <button type="button" className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white" onClick={start} disabled={!selected}>
              Iniciar
            </button>
            <button type="button" className="rounded border border-white/20 px-3 py-1.5 text-sm" onClick={pause} disabled={!selected}>
              Pausar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
