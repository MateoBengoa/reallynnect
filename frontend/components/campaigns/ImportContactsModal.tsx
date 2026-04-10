"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { LeadRow } from "./leadTypes";
import { LeadFinderApifyForm } from "./LeadFinderApifyForm";

type ImportContactsModalProps = {
  open: boolean;
  onClose: () => void;
  campaignId?: string;
  onDone?: () => void;
};

type GridItem = { mode: string; title: string; hint: string; needsCampaign?: boolean };

const GRID_SOURCES: GridItem[] = [
  {
    mode: "lead_finder",
    title: "Apify — Lead finder",
    hint: "Crea un run en console.apify.com y guarda contactos aquí. Requiere APIFY_TOKEN en el backend.",
  },
  { mode: "my_list", title: "Desde mi lista", hint: "Añade leads ya importados a la campaña.", needsCampaign: true },
  { mode: "csv", title: "CSV / pegar", hint: "Filas con profile_url y columnas opcionales." },
  { mode: "bulk_urls", title: "URLs (lote)", hint: "Una URL de perfil por línea." },
  {
    mode: "linkedin_search",
    title: "Búsqueda LinkedIn (scrape)",
    hint: "Solo cola + worker con tu sesión LinkedIn. No llama a Apify ni crea runs allí.",
  },
  {
    mode: "sales_navigator",
    title: "Sales Navigator (scrape)",
    hint: "Solo cola + worker. No Apify.",
  },
  { mode: "linkedin_event", title: "Evento (scrape)", hint: "Cola + worker. No Apify." },
  { mode: "linkedin_post", title: "Post (scrape)", hint: "Cola + worker. No Apify." },
  { mode: "linkedin_group", title: "Grupo (scrape)", hint: "Cola + worker. No Apify." },
];

function parseLeadCsv(text: string): { profile_url: string; name?: string; company?: string; title?: string; source?: string }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: { profile_url: string; name?: string; company?: string; title?: string; source?: string }[] = [];
  let start = 0;
  if (lines[0]?.toLowerCase().includes("profile") && lines[0]?.toLowerCase().includes("url")) start = 1;
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i]!.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ""));
    const profile_url = parts[0];
    if (!profile_url?.startsWith("http")) continue;
    const row: (typeof out)[0] = { profile_url };
    if (parts[1]) row.name = parts[1];
    if (parts[2]) row.company = parts[2];
    if (parts[3]) row.title = parts[3];
    if (parts[4]) row.source = parts[4];
    out.push(row);
  }
  return out;
}

export function ImportContactsModal({ open, onClose, campaignId, onDone }: ImportContactsModalProps) {
  const [mode, setMode] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [csvText, setCsvText] = useState("");
  const [bulkUrls, setBulkUrls] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [apifyStatus, setApifyStatus] = useState<string | null>(null);
  const apifySubmitLock = useRef(false);

  const loadLeads = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    try {
      const r = await api<{ leads: LeadRow[] }>("/leads");
      setLeads(r.leads ?? []);
    } catch (e) {
      console.warn("[ImportContactsModal] /leads", e);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMode(null);
      setSelected(new Set());
      void loadLeads();
    }
  }, [open, loadLeads]);

  const enrollSelected = useCallback(async () => {
    if (!campaignId || !selected.size) return;
    setBusy(true);
    try {
      if (!(await getValidAccessToken())) return;
      await api(`/campaigns/${campaignId}/enrollments`, {
        method: "POST",
        body: JSON.stringify({ lead_ids: [...selected] }),
      });
      onDone?.();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }, [campaignId, selected, onDone, onClose]);

  const importCsvOrUrls = useCallback(
    async (kind: "csv" | "urls") => {
      setBusy(true);
      try {
        if (!(await getValidAccessToken())) return;
        if (kind === "csv") {
          const rows = parseLeadCsv(csvText);
          if (!rows.length) {
            alert("No hay filas válidas");
            return;
          }
          await api("/leads/import", {
            method: "POST",
            body: JSON.stringify(campaignId ? { rows, campaign_id: campaignId } : { rows }),
          });
        } else {
          const urls = bulkUrls
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((u) => u.startsWith("http"));
          if (!urls.length) {
            alert("Sin URLs");
            return;
          }
          await api("/leads/import", {
            method: "POST",
            body: JSON.stringify(campaignId ? { urls, campaign_id: campaignId } : { urls }),
          });
        }
        onDone?.();
        onClose();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Error");
      } finally {
        setBusy(false);
      }
    },
    [campaignId, csvText, bulkUrls, onDone, onClose]
  );

  const startScrapeJob = useCallback(
    async (source_type: string) => {
      if (!jobUrl.trim()) {
        alert("Indica una URL");
        return;
      }
      setBusy(true);
      try {
        if (!(await getValidAccessToken())) return;
        const body = { source_type, payload: { url: jobUrl.trim() }, ...(campaignId ? { campaign_id: campaignId } : {}) };
        if (campaignId) {
          await api(`/campaigns/${campaignId}/import-job`, { method: "POST", body: JSON.stringify(body) });
        } else {
          await api("/leads/import-job", { method: "POST", body: JSON.stringify(body) });
        }
        onDone?.();
        onClose();
      } catch (e) {
        alert(e instanceof Error ? e.message : "Error");
      } finally {
        setBusy(false);
      }
    },
    [campaignId, jobUrl, onDone, onClose]
  );

  const startLeadFinderApify = useCallback(
    async (apify_input: Record<string, unknown>) => {
      if (apifySubmitLock.current) return;
      apifySubmitLock.current = true;
      setBusy(true);
      setApifyStatus("Llamando a Apify y guardando en la base de datos… Puede tardar varios minutos; no cierres esta pestaña.");
      try {
        if (!(await getValidAccessToken())) return;
        const payload = {
          apify_input,
          apify_actor_id: "M2FMdjRVeF1HPGFcc",
          ...(campaignId ? { campaign_id: campaignId } : {}),
        };
        const r = await api<{
          ok: boolean;
          new_leads: number;
          rows_with_linkedin: number;
          dataset_items: number;
          photos_resolved: number;
        }>("/leads/apify-import", {
          method: "POST",
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(52 * 60 * 1000),
        });
        setApifyStatus(null);
        let photoMsg = "";
        if (r.photos_resolved >= r.new_leads && r.new_leads > 0) {
          photoMsg = `\n✅ ${r.photos_resolved} fotos resueltas al instante.`;
        } else if (r.photos_resolved > 0) {
          photoMsg = `\n✅ ${r.photos_resolved} fotos resueltas al instante.\n⏳ Las fotos restantes se extraerán automáticamente en segundo plano (puede demorar unos minutos).`;
        } else if (r.new_leads > 0) {
          photoMsg = `\n⏳ Las fotos de perfil se extraerán automáticamente usando tu cuenta en segundo plano (puede demorar unos minutos).`;
        }
        alert(
          `Importación lista: ${r.new_leads} contactos nuevos (${r.rows_with_linkedin} URLs válidas).${photoMsg}`
        );
        onDone?.();
        onClose();
      } catch (e) {
        setApifyStatus(null);
        const raw = e instanceof Error ? e.message : String(e);
        try {
          const j = JSON.parse(raw) as { error?: string };
          alert(j.error ?? raw);
        } catch {
          alert(raw);
        }
      } finally {
        apifySubmitLock.current = false;
        setBusy(false);
      }
    },
    [campaignId, onDone, onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <button type="button" className="absolute inset-0 bg-black/60" aria-label="Cerrar" onClick={onClose} />
      <div
        className="popover-panel relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-[var(--radius-xl)] sm:rounded-[var(--radius-xl)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-contacts-title"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3 sm:px-5">
          <h2 id="import-contacts-title" className="text-lg font-semibold text-[var(--text)]">
            Importar contactos
          </h2>
          <button type="button" className="btn-ghost min-h-9 px-2" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {!mode && (
            <p className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-3 py-2 text-sm text-[var(--text)]">
              <strong className="font-semibold">Apify:</strong> elige la primera tarjeta «Apify — Lead finder». Si usas URL de LinkedIn abajo y «Encolar…», la petición es{" "}
              <code className="rounded bg-[color-mix(in_srgb,var(--surface)_32%,transparent)] px-1 text-xs">/leads/import-job</code> y{" "}
              <span className="font-medium">no</span> crea runs en Apify (solo scrape con el worker).
            </p>
          )}
          {!mode && (
            <div className="grid gap-3 sm:grid-cols-2">
              {GRID_SOURCES.map((s) => (
                <button
                  key={s.mode}
                  type="button"
                  disabled={Boolean(s.needsCampaign && !campaignId)}
                  title={s.needsCampaign && !campaignId ? "Disponible dentro de una campaña" : undefined}
                  className="card card-pad text-left transition-[border-color,box-shadow] hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => setMode(s.mode)}
                >
                  <p className="font-medium text-[var(--text)]">{s.title}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{s.hint}</p>
                </button>
              ))}
            </div>
          )}

          {mode === "my_list" && campaignId && (
            <div className="space-y-3">
              <button type="button" className="btn-ghost min-h-9 px-0 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setMode(null)}>
                ← Volver
              </button>
              <p className="text-sm text-[var(--muted)]">Selecciona leads para inscribir en esta campaña.</p>
              <ul className="card card-pad max-h-64 space-y-1 overflow-y-auto text-sm shadow-none">
                {leads.map((l) => (
                  <li key={l.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => {
                        setSelected((prev) => {
                          const n = new Set(prev);
                          if (n.has(l.id)) n.delete(l.id);
                          else n.add(l.id);
                          return n;
                        });
                      }}
                    />
                    <span className="truncate">{l.name ?? l.profile_url}</span>
                  </li>
                ))}
              </ul>
              <button type="button" disabled={busy || !selected.size} className="btn-primary" onClick={() => void enrollSelected()}>
                Añadir a campaña ({selected.size})
              </button>
            </div>
          )}

          {mode === "csv" && (
            <div className="space-y-3">
              <button type="button" className="btn-ghost min-h-9 px-0 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setMode(null)}>
                ← Volver
              </button>
              <textarea
                className="input-field min-h-[160px] py-2 font-mono text-xs"
                placeholder="profile_url,name,company,title"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
              <button type="button" disabled={busy} className="btn-primary" onClick={() => void importCsvOrUrls("csv")}>
                Importar
              </button>
            </div>
          )}

          {mode === "bulk_urls" && (
            <div className="space-y-3">
              <button type="button" className="btn-ghost min-h-9 px-0 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setMode(null)}>
                ← Volver
              </button>
              <textarea
                className="input-field min-h-[160px] py-2 text-sm"
                placeholder="Una URL por línea"
                value={bulkUrls}
                onChange={(e) => setBulkUrls(e.target.value)}
              />
              <button type="button" disabled={busy} className="btn-primary" onClick={() => void importCsvOrUrls("urls")}>
                Importar URLs
              </button>
            </div>
          )}

          {mode &&
            mode !== "my_list" &&
            mode !== "csv" &&
            mode !== "bulk_urls" &&
            mode !== "lead_finder" && (
              <div className="space-y-3">
                <button type="button" className="btn-ghost min-h-9 px-0 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setMode(null)}>
                  ← Volver
                </button>
                <p className="text-sm text-[var(--muted)]">
                  Esto llama a <code className="text-xs">/leads/import-job</code> y encola scrape con tu cuenta LinkedIn. No aparecerá nada en Apify Console.
                </p>
                <input
                  className="input-field"
                  placeholder="https://www.linkedin.com/..."
                  value={jobUrl}
                  onChange={(e) => setJobUrl(e.target.value)}
                />
                <button type="button" disabled={busy} className="btn-primary" onClick={() => void startScrapeJob(mode)}>
                  Encolar scrape (sin Apify)
                </button>
              </div>
            )}

          {mode === "lead_finder" && (
            <div className="space-y-3">
              <button type="button" className="btn-ghost min-h-9 px-0 text-[var(--accent)] hover:text-[var(--accent)]" onClick={() => setMode(null)}>
                ← Volver
              </button>
              {apifyStatus ? (
                <p className="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-sm text-[var(--text)]">
                  {apifyStatus}
                </p>
              ) : null}
              <LeadFinderApifyForm busy={busy} onEnqueue={(payload) => void startLeadFinderApify(payload)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
