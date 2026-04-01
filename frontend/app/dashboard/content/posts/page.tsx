"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { ContentAccount, ContentPost, InboundEvent } from "@/lib/contentTypes";

const labelCap = "block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]";

function formatApiError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  try {
    const j = JSON.parse(e.message) as { error?: string };
    if (j?.error && typeof j.error === "string") return j.error;
  } catch {
    /* texto plano */
  }
  return e.message;
}

type CreateMode = "ai" | "manual";

const STATUS_META: Record<
  string,
  { label: string; activeClass: string; muted?: boolean }
> = {
  draft: {
    label: "Borrador",
    activeClass:
      "border-[color-mix(in_srgb,var(--muted)_40%,var(--border))] bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))] text-[var(--muted)]",
  },
  scheduled: {
    label: "Programado",
    activeClass:
      "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)]",
  },
  published: {
    label: "Publicado",
    activeClass:
      "border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_14%,var(--surface))] text-[#86efac]",
  },
  failed: {
    label: "Error",
    activeClass:
      "border-[color-mix(in_srgb,#f87171_45%,var(--border))] bg-[color-mix(in_srgb,#ef4444_12%,var(--surface))] text-[#fca5a5]",
  },
};

function statusBadge(status: string) {
  const m = STATUS_META[status] ?? {
    label: status,
    activeClass: "border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))] text-[var(--muted)]",
  };
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide border ${m.activeClass}`}>
      {m.label}
    </span>
  );
}

export default function ContentPostsPage() {
  const [posts, setPosts] = useState<ContentPost[]>([]);
  const [accounts, setAccounts] = useState<ContentAccount[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [createMode, setCreateMode] = useState<CreateMode | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const [topic, setTopic] = useState("");
  const [withImage, setWithImage] = useState(false);
  const [manualAccount, setManualAccount] = useState("");
  const [manualContent, setManualContent] = useState("");

  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const [inboundOpen, setInboundOpen] = useState(false);
  const [syncAccountId, setSyncAccountId] = useState("");
  const [syncBanner, setSyncBanner] = useState<string | null>(null);

  const accountById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);
  const activeAccounts = useMemo(() => accounts.filter((a) => a.connection_status === "active"), [accounts]);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [po, acc] = await Promise.all([
      api<{ posts: ContentPost[] }>("/posts"),
      api<{ accounts: ContentAccount[] }>("/linkedin-accounts"),
    ]);
    setPosts(po.posts);
    setAccounts(acc.accounts);
  }, []);

  const loadInbound = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ events: InboundEvent[] }>("/inbound-comment-events");
    setEvents(r.events);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadInbound();
  }, [loadInbound]);

  useEffect(() => {
    if (accounts.length > 0 && !manualAccount) setManualAccount(accounts[0]!.id);
  }, [accounts, manualAccount]);

  useEffect(() => {
    if (activeAccounts.length > 0 && !syncAccountId) setSyncAccountId(activeAccounts[0]!.id);
  }, [activeAccounts, syncAccountId]);

  function openWizard() {
    setWizardError(null);
    setWizardStep(1);
    setCreateMode(null);
    setTopic("");
    setWithImage(false);
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

  function selectMode(mode: CreateMode) {
    setCreateMode(mode);
    setWizardError(null);
    setWizardStep(2);
  }

  async function submitWizardAi() {
    if (!topic.trim()) {
      setWizardError("Indica un tema para el post.");
      return;
    }
    setWizardError(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/posts/generate", {
        method: "POST",
        body: JSON.stringify({ topic: topic.trim(), with_image: withImage }),
      });
      setWizardStep(3);
      await load();
    } catch (e) {
      const msg = formatApiError(e);
      setWizardError(
        /gemini|503|GEMINI_API_KEY/i.test(msg) ? "IA no disponible: revisa GEMINI_API_KEY en el backend." : msg
      );
    }
  }

  async function submitWizardManual() {
    if (!manualAccount || !manualContent.trim()) {
      setWizardError("Elige cuenta y escribe el contenido.");
      return;
    }
    setWizardError(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/posts", {
        method: "POST",
        body: JSON.stringify({ account_id: manualAccount, content: manualContent.trim() }),
      });
      setManualContent("");
      setWizardStep(3);
      await load();
    } catch (e) {
      setWizardError(formatApiError(e));
    }
  }

  async function schedule() {
    if (!scheduleId || !scheduleAt) return;
    if (!(await getValidAccessToken())) return;
    const iso = new Date(scheduleAt).toISOString();
    await api(`/posts/${scheduleId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduled_time: iso }),
    });
    setScheduleId(null);
    setScheduleAt("");
    await load();
  }

  async function syncLinkedInPosts(accountId: string) {
    setSyncBanner(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api<{ ok: boolean }>(`/linkedin-accounts/${accountId}/sync-posts`, { method: "POST" });
      setSyncBanner("Sincronización en cola. En unos minutos recarga o espera: el worker importará publicaciones desde LinkedIn.");
      window.setTimeout(() => load(), 8000);
      window.setTimeout(() => load(), 25000);
    } catch (e) {
      setSyncBanner(formatApiError(e));
    }
  }

  async function syncAllLinkedInPosts() {
    setSyncBanner(null);
    if (!(await getValidAccessToken())) return;
    try {
      for (const a of activeAccounts) {
        await api<{ ok: boolean }>(`/linkedin-accounts/${a.id}/sync-posts`, { method: "POST" });
      }
      setSyncBanner(
        `${activeAccounts.length} sincronización(es) en cola (una por cuenta activa). Los posts aparecerán al completar el worker.`
      );
      window.setTimeout(() => load(), 8000);
      window.setTimeout(() => load(), 25000);
    } catch (e) {
      setSyncBanner(formatApiError(e));
    }
  }

  async function saveEdit() {
    if (!editId || !editContent.trim()) return;
    if (!(await getValidAccessToken())) return;
    await api(`/posts/${editId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: editContent.trim() }),
    });
    setEditId(null);
    await load();
  }

  const hasImage = (p: ContentPost) => Boolean(p.image_url?.trim());

  const stepTitle =
    wizardStep === 1 ? "Cómo quieres crear el post" : wizardStep === 2 ? (createMode === "ai" ? "Tema e imagen" : "Texto y cuenta") : "Listo";

  return (
    <div className="min-w-0">
      <Link
        href="/dashboard/content"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">
          ←
        </span>
        Volver a Contenido
      </Link>

      <header className="mb-6 max-w-3xl">
        <h1 className="page-title mb-2">Posts</h1>
        <p className="page-desc leading-relaxed">
          Listado unificado (hasta 5000) con borradores de la app, programados y publicaciones importadas desde LinkedIn. Crea contenido con el
          asistente o sincroniza tu actividad reciente.
        </p>
      </header>

      <div className="card card-pad mb-8 max-w-3xl space-y-3 border-[color-mix(in_srgb,var(--accent)_22%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_5%,var(--surface))]">
        <h2 className="text-sm font-semibold text-[var(--text)]">Sincronizar desde LinkedIn</h2>
        <p className="text-xs leading-relaxed text-[var(--muted)]">
          El worker abre tu perfil (actividad reciente) y guarda publicaciones como «Publicado» con enlace. También puedes lanzarlo desde{" "}
          <Link href="/dashboard/settings" className="text-[var(--accent)] underline-offset-2 hover:underline">
            Ajustes
          </Link>
          . Requiere sesión <span className="text-[var(--text)]">active</span>.
        </p>
        {activeAccounts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No hay cuentas con sesión activa. Configura la cookie en Ajustes o Cuentas.</p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="min-w-[12rem] flex-1 text-xs font-medium text-[var(--muted)]">
              Cuenta
              <select
                className="input-field mt-1 min-h-[2.5rem] w-full py-2 text-sm"
                value={syncAccountId}
                onChange={(e) => setSyncAccountId(e.target.value)}
              >
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.li_display_name ?? a.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-primary min-h-10" onClick={() => void syncLinkedInPosts(syncAccountId)}>
              Sincronizar esta cuenta
            </button>
            {activeAccounts.length > 1 && (
              <button type="button" className="btn-secondary min-h-10" onClick={() => void syncAllLinkedInPosts()}>
                Sincronizar todas
              </button>
            )}
          </div>
        )}
        {syncBanner && <p className="text-sm text-[var(--muted)]">{syncBanner}</p>}
      </div>

      <h2 className={`${labelCap} mb-3`}>Publicaciones</h2>
      <div className="mb-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <button
          type="button"
          onClick={openWizard}
          className="group flex min-h-[14rem] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_38%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-4 py-8 text-center transition-[border-color,background-color,box-shadow] hover:border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_45%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        >
          <span
            className="flex h-12 w-12 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)] transition-transform group-hover:scale-105"
            aria-hidden
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </span>
          <span className="text-base font-semibold text-[var(--text)]">Crear post</span>
          <span className="max-w-[15rem] text-xs leading-snug text-[var(--muted)]">Asistente: IA desde un tema o texto manual en varios pasos.</span>
        </button>

        {posts.map((p) => {
          const account = accountById[p.account_id];
          const name = account?.li_display_name ?? `Cuenta ${p.account_id.slice(0, 8)}`;
          const photo = account?.li_photo_url;
          const headline = account?.li_headline;
          return (
            <article key={p.id} className="card flex flex-col overflow-hidden shadow-[var(--shadow-sm)]">
              {/* Header estilo LinkedIn */}
              <div className="flex items-start gap-3 px-4 pt-4">
                {/* Avatar */}
                <div className="relative shrink-0">
                  {photo ? (
                    <img src={photo} alt={name} className="h-11 w-11 rounded-full object-cover ring-1 ring-[var(--border)]" />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,var(--surface))] text-base font-bold text-[var(--accent)] ring-1 ring-[var(--border)]">
                      {name.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                {/* Nombre + subtítulo */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--text)]">{name}</span>
                    {statusBadge(p.status)}
                  </div>
                  {headline && <p className="truncate text-[11px] text-[var(--muted)]">{headline}</p>}
                  {p.scheduled_time && (
                    <p className="text-[11px] text-[var(--muted)]">
                      Programado: {new Date(p.scheduled_time).toLocaleString("es")}
                    </p>
                  )}
                </div>
              </div>

              {/* Texto del post */}
              <div className="px-4 pt-3">
                <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--text)] line-clamp-[8]">
                  {p.content}
                </p>
              </div>

              {/* Imagen al estilo LinkedIn (ancho completo) */}
              {hasImage(p) && p.image_url && (
                <div className="mt-3 overflow-hidden border-y border-[var(--border)]">
                  <img
                    src={p.image_url}
                    alt="Imagen del post"
                    className="w-full object-cover"
                    style={{ maxHeight: "320px" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
              )}

              {/* Acciones */}
              <div className="mt-auto flex flex-wrap gap-2 px-4 py-3 pt-3">
                {p.linkedin_activity_url && (
                  <a href={p.linkedin_activity_url} className="btn-secondary min-h-8 text-xs" target="_blank" rel="noreferrer">
                    Ver en LinkedIn ↗
                  </a>
                )}
                {p.status === "draft" && (
                  <>
                    <button type="button" className="btn-secondary min-h-8 text-xs" onClick={() => setScheduleId(p.id)}>
                      Programar
                    </button>
                    <button
                      type="button"
                      className="btn-secondary min-h-8 text-xs"
                      onClick={() => { setEditId(p.id); setEditContent(p.content); }}
                    >
                      Editar
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {posts.length === 0 && (
        <p className="-mt-6 mb-10 text-sm text-[var(--muted)]">Aún no hay posts en tus cuentas. Usa «Crear post» para el primero.</p>
      )}

      <section className="card overflow-hidden shadow-[var(--shadow-sm)]">
        <button
          type="button"
          onClick={() => setInboundOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))] sm:px-5"
        >
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)] sm:text-base">Eventos inbound</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">Comentarios detectados por poll_comments ({events.length})</p>
          </div>
          <span className="text-[var(--muted)]" aria-hidden>
            {inboundOpen ? "▾" : "▸"}
          </span>
        </button>
        {inboundOpen && (
          <div className="card-pad max-h-[min(50vh,28rem)] overflow-y-auto">
            <ul className="grid gap-3 sm:grid-cols-2">
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] p-3 text-sm"
                >
                  <span className="font-medium text-[var(--text)]">{ev.event_type}</span>
                  <span className="text-[var(--muted)]"> · {new Date(ev.created_at).toLocaleString("es")}</span>
                  {ev.detail && (
                    <pre className="mt-2 max-h-24 overflow-auto rounded bg-[color-mix(in_srgb,var(--text)_6%,var(--bg))] p-2 text-[10px] text-[var(--muted)]">
                      {JSON.stringify(ev.detail, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
            {events.length === 0 && <p className="text-sm text-[var(--muted)]">Sin eventos aún.</p>}
          </div>
        )}
      </section>

      {wizardOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="post-wizard-title">
          <div className="popover-panel flex max-h-[min(92vh,40rem)] w-full max-w-lg flex-col overflow-hidden shadow-[var(--shadow-md)]">
            <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] px-4 py-4 sm:px-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                    Paso {wizardStep} de 3 · {stepTitle}
                  </p>
                  <h2 id="post-wizard-title" className="mt-1 text-lg font-semibold text-[var(--text)]">
                    Nuevo post
                  </h2>
                </div>
                <button type="button" className="btn-ghost min-h-9 px-2 text-sm" onClick={closeWizard}>
                  Cerrar
                </button>
              </div>
              <div className="mt-3 flex gap-1.5" aria-hidden>
                {[1, 2, 3].map((s) => (
                  <div
                    key={s}
                    className={`h-1 flex-1 rounded-full ${s <= wizardStep ? "bg-[var(--accent)]" : "bg-[color-mix(in_srgb,var(--text)_12%,var(--border))]"}`}
                  />
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
              {wizardError && (
                <p className="mb-4 rounded-md border border-[color-mix(in_srgb,#f87171_40%,var(--border))] bg-[color-mix(in_srgb,#ef4444_10%,var(--surface))] px-3 py-2 text-sm text-[#fca5a5]">
                  {wizardError}
                </p>
              )}

              {wizardStep === 1 && (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--muted)]">Elige una opción. Podrás volver atrás en el siguiente paso.</p>
                  <button
                    type="button"
                    onClick={() => selectMode("ai")}
                    className="flex w-full flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))] p-4 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))]"
                  >
                    <span className="font-semibold text-[var(--text)]">Con IA</span>
                    <span className="mt-1 text-xs leading-snug text-[var(--muted)]">
                      Describe un tema; generamos el borrador (texto e imagen opcional con Gemini).
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectMode("manual")}
                    className="flex w-full flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))] p-4 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))]"
                  >
                    <span className="font-semibold text-[var(--text)]">Manual</span>
                    <span className="mt-1 text-xs leading-snug text-[var(--muted)]">
                      Elige la cuenta de LinkedIn y escribe el texto del borrador tú mismo.
                    </span>
                  </button>
                </div>
              )}

              {wizardStep === 2 && createMode === "ai" && (
                <div className="space-y-4">
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Tema del post</span>
                    <input
                      className="input-field text-sm"
                      placeholder="Ej. tendencias B2B en 2026"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      autoFocus
                    />
                  </label>
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-3.5 py-3">
                    <span className="text-sm text-[var(--text)]">Generar imagen con Gemini</span>
                    <input
                      type="checkbox"
                      checked={withImage}
                      onChange={(e) => setWithImage(e.target.checked)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                  </label>
                </div>
              )}

              {wizardStep === 2 && createMode === "manual" && (
                <div className="space-y-4">
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Cuenta</span>
                    <select
                      className="input-field min-h-[2.5rem] w-full py-2 text-sm"
                      value={manualAccount}
                      onChange={(e) => setManualAccount(e.target.value)}
                    >
                      {accounts.length === 0 ? (
                        <option value="">Añade una cuenta de LinkedIn primero</option>
                      ) : (
                        accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.li_display_name ?? a.id.slice(0, 8)}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <label className="block">
                    <span className={`${labelCap} mb-2`}>Contenido</span>
                    <textarea
                      className="input-field min-h-[160px] resize-y py-2.5 text-sm leading-relaxed"
                      placeholder="Escribe el post…"
                      value={manualContent}
                      onChange={(e) => setManualContent(e.target.value)}
                    />
                  </label>
                </div>
              )}

              {wizardStep === 3 && (
                <div className="py-4 text-center">
                  <div
                    className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_12%,var(--surface))] text-[#86efac]"
                    aria-hidden
                  >
                    <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-base font-semibold text-[var(--text)]">Borrador creado</p>
                  <p className="mt-2 text-sm text-[var(--muted)]">Ya aparece en la cuadrícula de arriba. Puedes programarlo o editarlo desde la tarjeta.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-4 py-3 sm:px-5">
              {wizardStep === 1 && <span />}
              {wizardStep > 1 && wizardStep < 3 && (
                <button
                  type="button"
                  className="btn-secondary min-h-10"
                  onClick={() => {
                    setWizardError(null);
                    if (wizardStep === 2) {
                      setWizardStep(1);
                      setCreateMode(null);
                    }
                  }}
                >
                  Atrás
                </button>
              )}
              <div className="ml-auto flex gap-2">
                {wizardStep === 2 && createMode === "ai" && (
                  <button type="button" className="btn-primary min-h-10" onClick={() => void submitWizardAi()}>
                    Generar borrador
                  </button>
                )}
                {wizardStep === 2 && createMode === "manual" && (
                  <button type="button" className="btn-primary min-h-10" onClick={() => void submitWizardManual()}>
                    Guardar borrador
                  </button>
                )}
                {wizardStep === 3 && (
                  <button type="button" className="btn-primary min-h-10" onClick={closeWizard}>
                    Entendido
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {scheduleId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-sm p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Fecha de publicación (local)</p>
            <input
              type="datetime-local"
              className="input-field mb-3 min-h-10"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={() => void schedule()}>
                Confirmar
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setScheduleId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-lg p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Editar borrador</p>
            <textarea
              className="input-field mb-3 min-h-[180px] py-2 text-sm"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={() => void saveEdit()}>
                Guardar
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
