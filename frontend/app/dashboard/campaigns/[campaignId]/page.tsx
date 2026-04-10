"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import { startLeadPhotoPoll } from "@/lib/leadPhotoPoll";
import { ImportContactsModal } from "@/components/campaigns/ImportContactsModal";
import { LeadDetailDrawer } from "@/components/campaigns/LeadDetailDrawer";
import { LeadsDataTable } from "@/components/campaigns/LeadsDataTable";
import type { EnrollmentRow, LeadRow } from "@/components/campaigns/leadTypes";
import { defaultLinearEdges, type WorkflowStep } from "@/components/CampaignWorkflowEditor";

const CampaignWorkflowEditor = dynamic(
  () => import("@/components/CampaignWorkflowEditor").then((m) => ({ default: m.CampaignWorkflowEditor })),
  {
    ssr: false,
    loading: () => <div className="card min-h-[360px] animate-pulse card-pad bg-[color-mix(in_srgb,var(--text)_4%,transparent)]" aria-hidden />,
  }
);

const TABS = ["leads", "builder", "analytics", "settings"] as const;
type TabId = (typeof TABS)[number];

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
  { step_type: "visit_profile", delay_hours: 0, message_template: null, position_x: 0, position_y: 72 },
  { step_type: "wait", delay_hours: 24, message_template: null, position_x: 236, position_y: 72 },
  { step_type: "connect", delay_hours: 0, message_template: "", position_x: 472, position_y: 72 },
];

function defaultScheduleJson() {
  return Array.from({ length: 7 }, (_, day) => ({
    day,
    enabled: day < 5,
    start: "09:00",
    end: "17:00",
  }));
}

type Campaign = {
  id: string;
  name: string;
  status: string;
  skip_contacted_other_campaigns?: boolean;
  schedule_json?: unknown;
  frequency_limits?: Record<string, number> | null;
  workflow_edges?: unknown;
};

type LiAccount = {
  id: string;
  li_display_name: string | null;
  li_headline: string | null;
  li_photo_url: string | null;
  connection_status: string;
};

function tabFromQuery(q: string | null): TabId {
  if (q && (TABS as readonly string[]).includes(q)) return q as TabId;
  return "leads";
}

function asEdges(raw: unknown): Edge[] {
  if (!Array.isArray(raw)) return [];
  return raw as Edge[];
}

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const campaignId = params.campaignId as string;
  const tab = useMemo(() => tabFromQuery(searchParams.get("tab")), [searchParams]);

  const setTab = useCallback(
    (t: TabId) => {
      router.replace(`/dashboard/campaigns/${campaignId}?tab=${t}`);
    },
    [router, campaignId]
  );

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [steps, setSteps] = useState<WorkflowStep[]>(DEFAULT_STEPS);
  const [edges, setEdges] = useState<Edge[]>(() => defaultLinearEdges(DEFAULT_STEPS.length));
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const stopEnrollmentPhotoPoll = useRef<(() => void) | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [drawerLead, setDrawerLead] = useState<LeadRow | null>(null);
  const [drawerEnr, setDrawerEnr] = useState<EnrollmentRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [analytics, setAnalytics] = useState<Record<string, unknown> | null>(null);

  const [startModalOpen, setStartModalOpen] = useState(false);
  const [liAccounts, setLiAccounts] = useState<LiAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  const [nameDraft, setNameDraft] = useState("");
  const [skipOther, setSkipOther] = useState(false);
  const [excludeConnect, setExcludeConnect] = useState(false);
  const [scheduleRows, setScheduleRows] = useState(defaultScheduleJson);
  const [freq, setFreq] = useState<Record<string, number>>({});

  const loadCampaignBundle = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [cRes, sRes] = await Promise.all([
      api<{ campaign: Campaign }>(`/campaigns/${campaignId}`),
      api<{ steps: WorkflowStep[] }>(`/campaigns/${campaignId}/steps`),
    ]);
    const c = cRes.campaign;
    setCampaign(c);
    setNameDraft(c.name);
    setSkipOther(Boolean(c.skip_contacted_other_campaigns));
    const sched = c.schedule_json;
    if (Array.isArray(sched) && sched.length === 7) setScheduleRows(sched as typeof scheduleRows);
    else setScheduleRows(defaultScheduleJson());
    setFreq((c.frequency_limits as Record<string, number>) ?? {});
    const list = sRes.steps?.length ? sRes.steps : DEFAULT_STEPS;
    setSteps(list);
    const we = asEdges(c.workflow_edges);
    setEdges(we.length ? we : defaultLinearEdges(list.length));
  }, [campaignId]);

  const loadEnrollments = useCallback(async (opts?: { batchSyncPhotos?: boolean }) => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ enrollments: EnrollmentRow[] }>(`/campaigns/${campaignId}/enrollments`);
    setEnrollments(r.enrollments ?? []);
    if (opts?.batchSyncPhotos) {
      const ids = (r.enrollments ?? [])
        .map((e) => e.leads)
        .filter((l): l is LeadRow => Boolean(l))
        .filter(
          (l) =>
            !l.photo_url &&
            String(l.profile_url ?? "").toLowerCase().includes("linkedin.com") &&
            String(l.profile_url ?? "").toLowerCase().includes("/in/")
        )
        .map((l) => l.id);
      const unique = [...new Set(ids)];
      if (unique.length) {
        /* Primero intentar fotos públicas (Microlink / og:image / unavatar) — no requiere cuenta LI */
        try {
          const fetchRes = await api<{ updated: number; attempted: number }>("/leads/fetch-photos", {
            method: "POST",
            body: JSON.stringify({ max: 60, concurrency: 4 }),
          });
          if (fetchRes.updated > 0) {
            const r1 = await api<{ enrollments: EnrollmentRow[] }>(`/campaigns/${campaignId}/enrollments`);
            setEnrollments(r1.enrollments ?? []);
          }
        } catch {
          /* fetch-photos falló; seguimos con batch-sync */
        }
        /* Luego intentar con worker LinkedIn (requiere cuenta activa) */
        try {
          stopEnrollmentPhotoPoll.current?.();
          stopEnrollmentPhotoPoll.current = null;
          const syncRes = await api<{ ok: boolean; queued: number }>("/leads/batch-sync-photos", {
            method: "POST",
            body: JSON.stringify({ max: 45, lead_ids: unique.slice(0, 120) }),
          });
          if (syncRes.queued > 0) {
            stopEnrollmentPhotoPoll.current = startLeadPhotoPoll(async () => {
              const r2 = await api<{ enrollments: EnrollmentRow[] }>(`/campaigns/${campaignId}/enrollments`);
              setEnrollments(r2.enrollments ?? []);
              return (r2.enrollments ?? []).map((e) => e.leads).filter(Boolean) as LeadRow[];
            });
          }
        } catch {
          /* Sin cuenta LI activa; el usuario puede sincronizar después */
        }
      }
    }
  }, [campaignId]);

  const loadAnalytics = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<Record<string, unknown>>(`/campaigns/${campaignId}/analytics`);
    setAnalytics(r);
  }, [campaignId]);

  const loadProfile = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ profile: { exclude_connect_messages_from_reply_rate?: boolean } }>("/me");
    setExcludeConnect(Boolean(r.profile?.exclude_connect_messages_from_reply_rate));
  }, []);

  useEffect(() => {
    void loadCampaignBundle();
    void loadProfile();
  }, [loadCampaignBundle, loadProfile]);

  useEffect(() => {
    if (tab === "leads") void loadEnrollments();
  }, [tab, loadEnrollments]);

  useEffect(() => {
    if (tab === "analytics") void loadAnalytics();
  }, [tab, loadAnalytics]);

  useEffect(() => {
    return () => {
      stopEnrollmentPhotoPoll.current?.();
      stopEnrollmentPhotoPoll.current = null;
    };
  }, []);

  useEffect(() => {
    const id = drawerLead?.id;
    if (!id) return;
    const en = enrollments.find((e) => e.leads?.id === id);
    if (en?.leads) setDrawerLead(en.leads as LeadRow);
  }, [enrollments, drawerLead?.id]);

  function stepsPayload() {
    return steps.map((s) => ({
      step_type: s.step_type,
      delay_hours: s.delay_hours,
      message_template: s.message_template || undefined,
      position_x: s.position_x ?? null,
      position_y: s.position_y ?? null,
    }));
  }

  async function saveSteps() {
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}/steps`, {
      method: "PUT",
      body: JSON.stringify({ steps: stepsPayload(), workflow_edges: edges }),
    });
    await loadCampaignBundle();
    alert("Flujo guardado");
  }

  async function openStartModal() {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ accounts: LiAccount[] }>("/linkedin-accounts");
    const active = (r.accounts ?? []).filter((a) => a.connection_status === "active");
    setLiAccounts(active);
    setSelectedAccountId(active[0]?.id ?? "");
    setStartModalOpen(true);
  }

  async function start() {
    if (!(await getValidAccessToken())) return;
    setStartModalOpen(false);
    await api(`/campaigns/${campaignId}/steps`, {
      method: "PUT",
      body: JSON.stringify({ steps: stepsPayload(), workflow_edges: edges }),
    });
    const body: Record<string, unknown> = {};
    if (selectedAccountId) body.account_id = selectedAccountId;
    const r = await api<{
      leads: number;
      tasks_scheduled: number;
      enrollments_new: number;
      enrollments_existing: number;
    }>(`/campaigns/${campaignId}/start`, { method: "POST", body: JSON.stringify(body) });
    alert(
      `Campaña iniciada. Leads: ${r.leads}. Tareas: ${r.tasks_scheduled}. Nuevas inscripciones: ${r.enrollments_new}.`
    );
    void loadCampaignBundle();
  }

  async function pause() {
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}/pause`, { method: "POST", body: JSON.stringify({}) });
    void loadCampaignBundle();
  }

  async function saveGeneral() {
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nameDraft, skip_contacted_other_campaigns: skipOther }),
    });
    await api("/me", {
      method: "PATCH",
      body: JSON.stringify({ exclude_connect_messages_from_reply_rate: excludeConnect }),
    });
    void loadCampaignBundle();
    void loadProfile();
    alert("Guardado");
  }

  async function saveSchedule() {
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}`, {
      method: "PATCH",
      body: JSON.stringify({ schedule_json: scheduleRows }),
    });
    void loadCampaignBundle();
    alert("Horario guardado (UTC)");
  }

  async function saveFrequency() {
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}`, {
      method: "PATCH",
      body: JSON.stringify({ frequency_limits: freq }),
    });
    void loadCampaignBundle();
    alert("Límites guardados");
  }

  async function deleteCampaign() {
    if (!confirm("¿Eliminar esta campaña? No se puede deshacer.")) return;
    if (!(await getValidAccessToken())) return;
    await api(`/campaigns/${campaignId}`, { method: "DELETE" });
    router.replace("/dashboard/campaigns");
  }

  const leadRows = useMemo(() => {
    return enrollments
      .map((e) => (e.leads ? { lead: e.leads as LeadRow, enrollment: e } : null))
      .filter(Boolean) as { lead: LeadRow; enrollment: EnrollmentRow }[];
  }, [enrollments]);

  const summary = (analytics?.summary ?? {}) as Record<string, unknown>;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href="/dashboard/campaigns" className="link-focus btn-ghost -ml-2 text-sm">
          ← Campañas
        </Link>
        {campaign && (
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            {campaign.status}
          </span>
        )}
      </div>
      <h1 className="page-title">{campaign?.name ?? "Campaña"}</h1>

      <div className="tabs-pill mb-8 mt-6 w-full max-w-2xl">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`tab-pill ${tab === t ? "tab-pill-active" : ""}`}
          >
            {t === "leads" ? "Leads" : t === "builder" ? "Builder" : t === "analytics" ? "Analytics" : "Ajustes"}
          </button>
        ))}
      </div>

      {tab === "leads" && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => setImportOpen(true)}>
              Importar contactos
            </button>
          </div>
          <LeadsDataTable
            showCrmColumn
            rows={leadRows}
            onRowClick={(lead, en) => {
              setDrawerLead(lead);
              setDrawerEnr(en ?? null);
              setDrawerOpen(true);
            }}
          />
        </div>
      )}

      {tab === "builder" && (
        <div className="space-y-5">
          <CampaignWorkflowEditor steps={steps} setSteps={setSteps} stepTypes={STEP_TYPES} edges={edges} setEdges={setEdges} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => void saveSteps()}>
              Guardar flujo
            </button>
            <button type="button" className="btn-primary" onClick={() => void openStartModal()}>
              Iniciar
            </button>
            <button type="button" className="btn-secondary" onClick={() => void pause()}>
              Pausar
            </button>
          </div>
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-5">
          <p className="page-desc">{(analytics?.note as string) ?? ""}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Kpi title="Solicitudes conexión" value={Number(summary.linkedin_requests ?? 0)} />
            <Kpi title="Mensajes / conversaciones" value={Number(summary.linkedin_conversations ?? 0)} />
            <Kpi title="InMails" value={Number(summary.linkedin_inmails_sent ?? 0)} />
            <Kpi title="Likes" value={Number(summary.linkedin_likes ?? 0)} />
            <Kpi title="Comentarios" value={Number(summary.linkedin_comments ?? 0)} />
            <Kpi title="Visitas perfil" value={Number(summary.profile_visits ?? 0)} />
            <Kpi title="% aceptación (aprox.)" value={summary.accepted_invite_pct != null ? `${summary.accepted_invite_pct}%` : "—"} />
            <Kpi title="% respuestas (aprox.)" value={summary.linkedin_replies_pct != null ? `${summary.linkedin_replies_pct}%` : "—"} />
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="max-w-2xl space-y-8">
          <section className="card overflow-hidden">
            <div className="card-header">General</div>
            <div className="card-pad space-y-4 sm:p-6">
              <p className="page-desc max-w-none text-xs">Cambia el nombre de la campaña o elimínala. Ajustes de exclusión y respuesta.</p>
              <div className="space-y-1.5">
                <label htmlFor="campaign-name" className="text-xs font-medium text-[var(--muted)]">
                  Nombre de la campaña
                </label>
                <input id="campaign-name" className="input-field" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
              </div>
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                <input type="checkbox" className="mt-0.5" checked={skipOther} onChange={(e) => setSkipOther(e.target.checked)} />
                <span>Omitir leads ya contactados en otras campañas</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                <input type="checkbox" className="mt-0.5" checked={excludeConnect} onChange={(e) => setExcludeConnect(e.target.checked)} />
                <span>Excluir mensajes de conexión del cálculo de tasa de respuesta (todas las campañas)</span>
              </label>
            </div>
            <div className="card-footer justify-between sm:justify-end">
              <button type="button" className="btn-danger" onClick={() => void deleteCampaign()}>
                Eliminar campaña
              </button>
              <button type="button" className="btn-primary" onClick={() => void saveGeneral()}>
                Guardar
              </button>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="card-header">Horario (UTC)</div>
            <div className="card-pad space-y-1 sm:p-6">
              <p className="page-desc mb-4 max-w-none text-xs">
                Solo en las franjas indicadas se programan acciones. Recomendamos al menos 7 h al día. Lunes = primer día.
              </p>
              {scheduleRows.map((row, idx) => (
                <div
                  key={row.day}
                  className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] py-3 text-sm last:border-0"
                >
                  <span className="w-14 shrink-0 font-medium text-[var(--text)]">{["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"][idx]}</span>
                  <label className="flex cursor-pointer items-center gap-2 text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) => {
                        const next = [...scheduleRows];
                        next[idx] = { ...next[idx]!, enabled: e.target.checked };
                        setScheduleRows(next);
                      }}
                    />
                    Activo
                  </label>
                  <input
                    type="time"
                    className="input-field w-auto min-w-0 max-w-[7rem] py-2 text-xs"
                    value={row.start}
                    onChange={(e) => {
                      const next = [...scheduleRows];
                      next[idx] = { ...next[idx]!, start: e.target.value };
                      setScheduleRows(next);
                    }}
                  />
                  <span className="text-[var(--muted)]">a</span>
                  <input
                    type="time"
                    className="input-field w-auto min-w-0 max-w-[7rem] py-2 text-xs"
                    value={row.end}
                    onChange={(e) => {
                      const next = [...scheduleRows];
                      next[idx] = { ...next[idx]!, end: e.target.value };
                      setScheduleRows(next);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="card-footer">
              <button type="button" className="btn-secondary" onClick={() => setScheduleRows(defaultScheduleJson())}>
                Restablecer
              </button>
              <button type="button" className="btn-primary" onClick={() => void saveSchedule()}>
                Guardar horario
              </button>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="card-header">Frecuencia diaria</div>
            <div className="card-pad space-y-4 sm:p-6">
              <p className="page-desc max-w-none text-xs">
                Límites alineados con el motor (messages, inmails, connection_requests, etc.). Usa un número alto para efectivamente «sin
                límite».
              </p>
              <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-4 text-xs leading-relaxed text-[var(--muted)]">
                <p className="font-semibold text-[var(--text)]">Nota</p>
                <p className="mt-2">
                  Los nodos que comprueban perfil abierto, etiquetas, invitación aceptada, datos en columna, mensaje abierto o respondido
                  pueden contar como visitas de perfil si van primero. Ajusta «Visitas perfil» si los usas.
                </p>
              </div>
              {[
                ["messages", "Mensajes"],
                ["inmails", "InMails"],
                ["connection_requests", "Invitaciones"],
                ["ai_comments", "Comentarios IA"],
                ["likes", "Likes"],
                ["profile_visits", "Visitas perfil"],
                ["follow_lead", "Seguir"],
                ["comments", "Comentarios"],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center justify-between gap-4 border-b border-[var(--border)] py-2 text-sm last:border-0">
                  <span className="text-[var(--text)]">{label}</span>
                  <input
                    type="number"
                    min={0}
                    className="input-field w-28 py-2 text-sm"
                    value={freq[key] ?? ""}
                    placeholder="9999"
                    onChange={(e) => {
                      const v = e.target.value === "" ? 0 : Number(e.target.value);
                      setFreq((f) => ({ ...f, [key]: v }));
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="card-footer">
              <button type="button" className="btn-primary" onClick={() => void saveFrequency()}>
                Guardar límites
              </button>
            </div>
          </section>
        </div>
      )}

      <ImportContactsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        campaignId={campaignId}
        onDone={() => void loadEnrollments({ batchSyncPhotos: true })}
      />
      <LeadDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        lead={drawerLead}
        enrollment={drawerEnr ?? undefined}
        campaignId={campaignId}
        onUpdated={() => void loadEnrollments().catch(() => {})}
        onRefreshLeads={() => loadEnrollments()}
      />

      {startModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--surface)_65%,transparent)] p-6 shadow-xl backdrop-blur-xl">
            <h2 className="mb-4 text-base font-semibold text-[var(--text)]">Elegir cuenta para iniciar</h2>
            {liAccounts.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No hay cuentas LinkedIn activas. Conecta una en la sección Cuentas.</p>
            ) : (
              <div className="space-y-2">
                {liAccounts.map((a) => (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                      selectedAccountId === a.id
                        ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
                        : "border-[var(--border)] hover:border-[var(--accent)]/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="start-account"
                      value={a.id}
                      checked={selectedAccountId === a.id}
                      onChange={() => setSelectedAccountId(a.id)}
                      className="accent-[var(--accent)]"
                    />
                    {a.li_photo_url ? (
                      <img src={a.li_photo_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text)_10%,transparent)] text-xs font-bold text-[var(--muted)]">
                        LI
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--text)]">
                        {a.li_display_name ?? a.id.slice(0, 8)}
                      </p>
                      {a.li_headline && (
                        <p className="truncate text-xs text-[var(--muted)]">{a.li_headline}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStartModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!selectedAccountId}
                onClick={() => void start()}
              >
                Iniciar campaña
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="kpi-card">
      <p className="text-xs font-medium text-[var(--muted)]">{title}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text)]">{value}</p>
    </div>
  );
}
