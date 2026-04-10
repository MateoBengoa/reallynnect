"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { ContentAccount, ContentPost } from "@/lib/contentTypes";

const labelCap = "block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]";

function formatApiError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  try {
    const j = JSON.parse(e.message) as { error?: string };
    if (j?.error && typeof j.error === "string") return j.error;
  } catch { /* texto plano */ }
  return e.message;
}

type CreateMode = "ai" | "manual";

const STATUS_META: Record<string, { label: string; activeClass: string }> = {
  draft:     { label: "Borrador",  activeClass: "border-[color-mix(in_srgb,var(--muted)_40%,var(--border))] bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-[var(--muted)]" },
  scheduled: { label: "Programado", activeClass: "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]" },
  published: { label: "Publicado",  activeClass: "border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_14%,transparent)] text-[#86efac]" },
  failed:    { label: "Error",      activeClass: "border-[color-mix(in_srgb,#f87171_45%,var(--border))] bg-[color-mix(in_srgb,#ef4444_12%,transparent)] text-[#fca5a5]" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, activeClass: "border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] text-[var(--muted)]" };
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${m.activeClass}`}>
      {m.label}
    </span>
  );
}

export default function ContentPostsPage() {
  const [posts, setPosts] = useState<ContentPost[]>([]);
  const [accounts, setAccounts] = useState<ContentAccount[]>([]);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [createMode, setCreateMode] = useState<CreateMode | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [manualAccount, setManualAccount] = useState("");
  const [manualContent, setManualContent] = useState("");

  const [generatingAi, setGeneratingAi] = useState(false);
  const router = useRouter();
  const [publishingNow, setPublishingNow] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");

  const accountById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [po, acc] = await Promise.all([
      api<{ posts: ContentPost[] }>("/posts"),
      api<{ accounts: ContentAccount[] }>("/linkedin-accounts"),
    ]);
    // Solo mostrar posts creados en la app: excluye los importados del sync
    // (los importados tienen status="published" y nunca tuvieron scheduled_time)
    const appPosts = (po.posts ?? []).filter(
      (p) => !(p.status === "published" && !p.scheduled_time)
    );
    setPosts(appPosts);
    setAccounts(acc.accounts);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (accounts.length > 0 && !manualAccount) setManualAccount(accounts[0]!.id);
  }, [accounts, manualAccount]);

  function openWizard() {
    setWizardError(null);
    setWizardStep(1);
    setCreateMode(null);
    setTopic("");
    setManualContent("");
    if (accounts[0]) setManualAccount(accounts[0].id);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setWizardStep(1);
    setCreateMode(null);
    setWizardError(null);
  }

  async function submitWizardAi() {
    if (!topic.trim()) { setWizardError("Indica un tema para el post."); return; }
    setWizardError(null);
    if (!(await getValidAccessToken())) return;
    setGeneratingAi(true);
    try {
      await api("/posts/generate", { method: "POST", body: JSON.stringify({ topic: topic.trim() }) });
      setWizardStep(3);
      await load();
    } catch (e) {
      const msg = formatApiError(e);
      setWizardError(/gemini|503|GEMINI_API_KEY/i.test(msg) ? "IA no disponible: revisa GEMINI_API_KEY en el backend." : msg);
    } finally {
      setGeneratingAi(false);
    }
  }

  async function submitWizardManual() {
    if (!manualAccount || !manualContent.trim()) { setWizardError("Elige cuenta y escribe el contenido."); return; }
    setWizardError(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/posts", { method: "POST", body: JSON.stringify({ account_id: manualAccount, content: manualContent.trim() }) });
      setManualContent("");
      setWizardStep(3);
      await load();
    } catch (e) { setWizardError(formatApiError(e)); }
  }

  async function publishNow(id: string) {
    setPublishingNow(id);
    try {
      if (!(await getValidAccessToken())) return;
      await api(`/posts/${id}/schedule`, {
        method: "POST",
        body: JSON.stringify({ scheduled_time: new Date().toISOString() }),
      });
      await load();
    } finally {
      setPublishingNow(null);
    }
  }

  async function schedule() {
    if (!scheduleId || !scheduleAt) return;
    if (!(await getValidAccessToken())) return;
    await api(`/posts/${scheduleId}/schedule`, { method: "POST", body: JSON.stringify({ scheduled_time: new Date(scheduleAt).toISOString() }) });
    setScheduleId(null);
    setScheduleAt("");
    await load();
  }

  const stepTitle = wizardStep === 1 ? "Cómo quieres crear el post" : wizardStep === 2 ? (createMode === "ai" ? "Tema e imagen" : "Texto y cuenta") : "Listo";

  return (
    <div className="min-w-0">
      <Link
        href="/dashboard/content"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">←</span>
        Volver a Contenido
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title mb-1">Posts</h1>
          <p className="page-desc">Borradores, programados y publicaciones creadas desde la app.</p>
        </div>
        <Link
          href="/dashboard/content/events"
          className="btn-secondary min-h-9 text-sm"
        >
          Ver eventos de comentarios →
        </Link>
      </header>

      {/* Grid de posts */}
      <div className="mb-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
        {/* Botón crear */}
        <button
          type="button"
          onClick={openWizard}
          className="group flex min-h-[14rem] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_38%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-4 py-8 text-center transition-[border-color,background-color] hover:border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] transition-transform group-hover:scale-105" aria-hidden>
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </span>
          <span className="text-base font-semibold text-[var(--text)]">Crear post</span>
          <span className="max-w-[15rem] text-xs leading-snug text-[var(--muted)]">Con IA desde un tema, o escribe el texto tú mismo.</span>
        </button>

        {posts.map((p) => {
          const account = accountById[p.account_id];
          const name = account?.li_display_name ?? `Cuenta ${p.account_id.slice(0, 8)}`;
          const photo = account?.li_photo_url ?? null;
          const headline = account?.li_headline ?? null;
          const initial = (account?.li_display_name ?? p.account_id).charAt(0).toUpperCase();
          return (
            <article
              key={p.id}
              className="card flex flex-col overflow-hidden shadow-[var(--shadow-sm)] cursor-pointer transition-[border-color,box-shadow] hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] hover:shadow-[var(--shadow-md)]"
              onClick={() => router.push(`/dashboard/content/posts/${p.id}`)}
            >
              {/* Header estilo LinkedIn */}
              <div className="flex items-start gap-3 px-4 pt-4">
                {photo ? (
                  <img src={photo} alt={name} className="h-11 w-11 shrink-0 rounded-full object-cover ring-1 ring-[var(--border)]" />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-base font-bold text-[var(--accent)] ring-1 ring-[var(--border)]">
                    {initial}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--text)]">{name}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  {headline && <p className="truncate text-[11px] text-[var(--muted)]">{headline}</p>}
                  {p.scheduled_time && (
                    <p className="text-[11px] text-[var(--muted)]">
                      Programado: {new Date(p.scheduled_time).toLocaleString("es")}
                    </p>
                  )}
                </div>
                {/* Indicador de editable */}
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)] opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </div>

              {/* Texto */}
              <div className="px-4 pt-3">
                <p className="line-clamp-4 whitespace-pre-line text-sm leading-relaxed text-[var(--text)]">
                  {p.content}
                </p>
              </div>

              {/* Imagen */}
              {p.image_url && (
                <div className="mt-3 overflow-hidden border-y border-[var(--border)]">
                  <img
                    src={p.image_url}
                    alt="Imagen del post"
                    className="w-full object-cover"
                    style={{ maxHeight: "200px" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
              )}

              {/* Acciones rápidas */}
              <div className="mt-auto flex flex-wrap gap-2 px-4 pb-4 pt-3">
                {p.linkedin_activity_url && (
                  <a
                    href={p.linkedin_activity_url}
                    className="btn-secondary min-h-8 text-xs"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Ver en LinkedIn ↗
                  </a>
                )}
                {p.status === "draft" && (
                  <>
                    <button
                      type="button"
                      disabled={publishingNow === p.id}
                      className="btn-primary min-h-8 text-xs disabled:opacity-50"
                      onClick={(e) => { e.stopPropagation(); void publishNow(p.id); }}
                    >
                      {publishingNow === p.id ? "Encolando…" : "Publicar ahora"}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary min-h-8 text-xs"
                      onClick={(e) => { e.stopPropagation(); setScheduleId(p.id); }}
                    >
                      Programar
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-8 text-xs text-[var(--muted)]"
                      onClick={(e) => { e.stopPropagation(); router.push(`/dashboard/content/posts/${p.id}`); }}
                    >
                      Editar →
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {posts.length === 0 && (
        <p className="-mt-6 mb-10 text-sm text-[var(--muted)]">Aún no hay posts. Usa «Crear post» para el primero.</p>
      )}

      {/* Wizard crear post */}
      {wizardOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="post-wizard-title">
          <div className="popover-panel flex max-h-[min(92vh,40rem)] w-full max-w-lg flex-col overflow-hidden shadow-[var(--shadow-md)]">
            <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Paso {wizardStep} de 3 · {stepTitle}</p>
                  <h2 id="post-wizard-title" className="mt-1 text-lg font-semibold text-[var(--text)]">Nuevo post</h2>
                </div>
                <button type="button" className="btn-ghost min-h-9 px-2 text-sm" onClick={closeWizard}>Cerrar</button>
              </div>
              <div className="mt-3 flex gap-1.5" aria-hidden>
                {[1, 2, 3].map((s) => (
                  <div key={s} className={`h-1 flex-1 rounded-full ${s <= wizardStep ? "bg-[var(--accent)]" : "bg-[color-mix(in_srgb,var(--text)_12%,var(--border))]"}`} />
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {wizardError && (
                <p className="mb-4 rounded-md border border-[color-mix(in_srgb,#f87171_40%,var(--border))] bg-[color-mix(in_srgb,#ef4444_10%,transparent)] px-3 py-2 text-sm text-[#fca5a5]">
                  {wizardError}
                </p>
              )}

              {wizardStep === 1 && (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--muted)]">Elige cómo quieres crear el post.</p>
                  <button type="button" onClick={() => { setCreateMode("ai"); setWizardStep(2); }} className="flex w-full flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-4 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]">
                    <span className="font-semibold text-[var(--text)]">Con IA</span>
                    <span className="mt-1 text-xs leading-snug text-[var(--muted)]">Describe un tema y Gemini genera el borrador (texto e imagen opcional).</span>
                  </button>
                  <button type="button" onClick={() => { setCreateMode("manual"); setWizardStep(2); }} className="flex w-full flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-4 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]">
                    <span className="font-semibold text-[var(--text)]">Manual</span>
                    <span className="mt-1 text-xs leading-snug text-[var(--muted)]">Escribe el texto tú mismo y elige la cuenta.</span>
                  </button>
                </div>
              )}

              {wizardStep === 2 && createMode === "ai" && (
                <div className="space-y-4">
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Tema del post</span>
                    <input className="input-field text-sm" placeholder="Ej. tendencias B2B en 2026" value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
                  </label>
                  <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
                    El borrador se crea en segundos. La imagen se genera desde la tarjeta una vez creado.
                  </p>
                </div>
              )}

              {wizardStep === 2 && createMode === "manual" && (
                <div className="space-y-4">
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Cuenta</span>
                    <select className="input-field min-h-[2.5rem] w-full py-2 text-sm" value={manualAccount} onChange={(e) => setManualAccount(e.target.value)}>
                      {accounts.length === 0 ? (
                        <option value="">Añade una cuenta de LinkedIn primero</option>
                      ) : (
                        accounts.map((a) => <option key={a.id} value={a.id}>{a.li_display_name ?? a.id.slice(0, 8)}</option>)
                      )}
                    </select>
                  </label>
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Contenido</span>
                    <textarea className="input-field min-h-[160px] resize-y py-2.5 text-sm leading-relaxed" placeholder="Escribe el post…" value={manualContent} onChange={(e) => setManualContent(e.target.value)} />
                  </label>
                </div>
              )}

              {wizardStep === 3 && (
                <div className="py-4 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_12%,transparent)] text-[#86efac]" aria-hidden>
                    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-base font-semibold text-[var(--text)]">Borrador creado</p>
                  <p className="mt-2 text-sm text-[var(--muted)]">Ya aparece en la cuadrícula. Podés programarlo o editarlo desde la tarjeta.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-5 py-3">
              {wizardStep > 1 && wizardStep < 3 ? (
                <button type="button" className="btn-secondary min-h-10" onClick={() => { setWizardError(null); setWizardStep(1); setCreateMode(null); }}>Atrás</button>
              ) : <span />}
              <div className="ml-auto flex gap-2">
                {wizardStep === 2 && createMode === "ai" && (
                  <button
                    type="button"
                    disabled={generatingAi}
                    className="btn-primary min-h-10 min-w-[10rem] disabled:opacity-60"
                    onClick={() => void submitWizardAi()}
                  >
                    {generatingAi ? (
                      <span className="flex items-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                        </svg>
                        Generando…
                      </span>
                    ) : "Generar borrador"}
                  </button>
                )}
                {wizardStep === 2 && createMode === "manual" && <button type="button" className="btn-primary min-h-10" onClick={() => void submitWizardManual()}>Guardar borrador</button>}
                {wizardStep === 3 && <button type="button" className="btn-primary min-h-10" onClick={closeWizard}>Entendido</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal programar */}
      {scheduleId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-sm p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Fecha de publicación (local)</p>
            <input type="datetime-local" className="input-field mb-3 min-h-10" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={() => void schedule()}>Confirmar</button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setScheduleId(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
