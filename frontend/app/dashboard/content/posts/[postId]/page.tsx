"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { ContentAccount, ContentPost } from "@/lib/contentTypes";

function formatApiError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  try {
    const j = JSON.parse(e.message) as { error?: string };
    if (j?.error) return j.error;
  } catch { /* texto plano */ }
  return e.message;
}

export default function PostDetailPage() {
  const { postId } = useParams<{ postId: string }>();
  const router = useRouter();

  const [post, setPost] = useState<ContentPost | null>(null);
  const [account, setAccount] = useState<ContentAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Editar texto
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Galería de imágenes generadas en esta sesión + la inicial
  const [images, setImages] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Publicar / programar
  const [publishingNow, setPublishingNow] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    try {
      // Intentar GET /posts/:id; si no existe (backend viejo), cargar lista y filtrar
      let p: ContentPost | null = null;
      try {
        const res = await api<{ post: ContentPost }>(`/posts/${postId}`);
        p = res.post;
      } catch {
        const { posts } = await api<{ posts: ContentPost[] }>("/posts");
        p = posts.find((x) => x.id === postId) ?? null;
      }
      if (!p) { setNotFound(true); return; }

      setPost(p);
      setContent(p.content);
      if (p.image_url) {
        setImages([p.image_url]);
        setSelectedIdx(0);
      }
      const { accounts } = await api<{ accounts: ContentAccount[] }>("/linkedin-accounts");
      setAccount(accounts.find((a) => a.id === p.account_id) ?? null);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => { load(); }, [load]);

  const isDraft = post?.status === "draft";
  const selectedImage = selectedIdx >= 0 ? images[selectedIdx] : null;

  async function save() {
    if (!post || saving || !isDraft) return;
    setSaving(true);
    setSaveOk(false);
    setSaveError(null);
    try {
      if (!(await getValidAccessToken())) return;
      const body: Record<string, unknown> = { content: content.trim() };
      if (selectedImage !== undefined) body.image_url = selectedImage ?? null;
      await api(`/posts/${post.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setPost((p) => p ? { ...p, content: content.trim(), image_url: selectedImage ?? null } : p);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (e) {
      setSaveError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  }

  async function generateImage() {
    if (!post || generatingImage) return;
    setGeneratingImage(true);
    setImageError(null);
    try {
      if (!(await getValidAccessToken())) return;
      const { image_url } = await api<{ image_url: string }>(`/posts/${post.id}/preview-image`, { method: "POST" });
      setImages((prev) => {
        const next = [...prev, image_url];
        setSelectedIdx(next.length - 1);
        return next;
      });
    } catch (e) {
      setImageError(formatApiError(e));
    } finally {
      setGeneratingImage(false);
    }
  }

  async function publishNow() {
    if (!post || publishingNow) return;
    setPublishingNow(true);
    try {
      if (!(await getValidAccessToken())) return;
      await api(`/posts/${post.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: content.trim(), image_url: selectedImage ?? null }),
      });
      await api(`/posts/${post.id}/schedule`, {
        method: "POST",
        body: JSON.stringify({ scheduled_time: new Date().toISOString() }),
      });
      router.push("/dashboard/content/posts");
    } finally {
      setPublishingNow(false);
    }
  }

  async function schedulePost() {
    if (!post || !scheduleAt) return;
    if (!(await getValidAccessToken())) return;
    await api(`/posts/${post.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: content.trim(), image_url: selectedImage ?? null }),
    });
    await api(`/posts/${post.id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduled_time: new Date(scheduleAt).toISOString() }),
    });
    router.push("/dashboard/content/posts");
  }

  if (loading) {
    return (
      <div className="flex min-h-[20rem] items-center justify-center">
        <svg className="h-6 w-6 animate-spin text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
        </svg>
      </div>
    );
  }

  if (notFound || !post) {
    return (
      <div className="py-12 text-center">
        <p className="text-[var(--muted)]">Post no encontrado.</p>
        <Link href="/dashboard/content/posts" className="btn-secondary mt-4 inline-flex">← Volver</Link>
      </div>
    );
  }

  const name = account?.li_display_name ?? `Cuenta ${post.account_id.slice(0, 8)}`;
  const photo = account?.li_photo_url ?? null;
  const initial = (account?.li_display_name ?? post.account_id).charAt(0).toUpperCase();

  return (
    <div className="min-w-0 pb-16">
      <Link
        href="/dashboard/content/posts"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">←</span>
        Volver a Posts
      </Link>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
        {/* Col izquierda: editor */}
        <div className="space-y-5">
          {/* Header cuenta */}
          <div className="card flex items-center gap-3 px-4 py-3">
            {photo ? (
              <img src={photo} alt={name} className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-[var(--border)]" />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-sm font-bold text-[var(--accent)] ring-1 ring-[var(--border)]">
                {initial}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--text)]">{name}</p>
              {account?.li_headline && <p className="truncate text-[11px] text-[var(--muted)]">{account.li_headline}</p>}
            </div>
            <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
              post.status === "draft"     ? "border-[color-mix(in_srgb,var(--muted)_40%,var(--border))] bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-[var(--muted)]" :
              post.status === "scheduled" ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]" :
              post.status === "published" ? "border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_14%,transparent)] text-[#86efac]" :
              "border-[color-mix(in_srgb,#f87171_45%,var(--border))] bg-[color-mix(in_srgb,#ef4444_12%,transparent)] text-[#fca5a5]"
            }`}>
              {post.status === "draft" ? "Borrador" : post.status === "scheduled" ? "Programado" : post.status === "published" ? "Publicado" : "Error"}
            </span>
          </div>

          {/* Editor texto */}
          <div className="card px-4 py-4">
            <label className="block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] mb-2">
              Texto del post
            </label>
            <textarea
              className="input-field min-h-[260px] resize-y py-2.5 text-sm leading-relaxed"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={!isDraft}
            />
            {saveError && (
              <p className="mt-2 text-xs text-[#fca5a5]">{saveError}</p>
            )}
            {isDraft && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  className="btn-secondary min-h-9 text-sm disabled:opacity-50"
                  onClick={() => void save()}
                >
                  {saving ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      Guardando…
                    </span>
                  ) : "Guardar cambios"}
                </button>
                {saveOk && <span className="text-xs text-[#86efac]">Guardado</span>}
              </div>
            )}
          </div>

          {/* Acciones */}
          {isDraft && (
            <div className="card flex flex-wrap gap-2 px-4 py-3">
              <button
                type="button"
                disabled={publishingNow}
                className="btn-primary min-h-9 text-sm disabled:opacity-50"
                onClick={() => void publishNow()}
              >
                {publishingNow ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                    </svg>
                    Encolando…
                  </span>
                ) : "Publicar ahora"}
              </button>
              <button
                type="button"
                className="btn-secondary min-h-9 text-sm"
                onClick={() => setScheduleOpen(true)}
              >
                Programar
              </button>
              {post.linkedin_activity_url && (
                <a href={post.linkedin_activity_url} className="btn-secondary min-h-9 text-sm" target="_blank" rel="noreferrer">
                  Ver en LinkedIn ↗
                </a>
              )}
            </div>
          )}
          {!isDraft && post.linkedin_activity_url && (
            <div className="card px-4 py-3">
              <a href={post.linkedin_activity_url} className="btn-secondary min-h-9 text-sm" target="_blank" rel="noreferrer">
                Ver en LinkedIn ↗
              </a>
            </div>
          )}
        </div>

        {/* Col derecha: galería de imágenes */}
        <div className="space-y-4">
          <div className="card px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                Imagen del post
              </p>
              {images.length > 0 && (
                <span className="text-[11px] text-[var(--muted)]">{selectedIdx + 1} / {images.length}</span>
              )}
            </div>

            {/* Imagen seleccionada */}
            {selectedImage ? (
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                <img
                  src={selectedImage}
                  alt="Imagen seleccionada"
                  className="w-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              </div>
            ) : (
              <div className="flex min-h-[180px] items-center justify-center rounded-[var(--radius-md)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_30%,var(--border))] text-xs text-[var(--muted)]">
                Sin imagen
              </div>
            )}

            {/* Miniaturas historial */}
            {images.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={`relative h-16 w-16 overflow-hidden rounded-[var(--radius-sm)] border-2 transition-[border-color] ${
                      i === selectedIdx
                        ? "border-[var(--accent)]"
                        : "border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent)_50%,var(--border))]"
                    }`}
                    title={i === 0 ? "Imagen original" : `Generación ${i}`}
                  >
                    <img src={img} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}

            {/* Botón generar */}
            {isDraft && (
              <div className="mt-4 space-y-2">
                {imageError && <p className="text-xs text-[#fca5a5]">{imageError}</p>}
                <button
                  type="button"
                  disabled={generatingImage}
                  className="btn-secondary w-full min-h-10 text-sm disabled:opacity-50"
                  onClick={() => void generateImage()}
                >
                  {generatingImage ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      Generando imagen…
                    </span>
                  ) : images.length > 0 ? "Generar otra imagen" : "Generar imagen con IA"}
                </button>
                {images.length > 0 && selectedIdx >= 0 && (
                  <p className="text-center text-[11px] text-[var(--muted)]">
                    Al guardar se usará la imagen seleccionada
                  </p>
                )}
                {selectedImage && (
                  <button
                    type="button"
                    className="w-full text-center text-[11px] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
                    onClick={() => { setSelectedIdx(-1); }}
                  >
                    Quitar imagen
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal programar */}
      {scheduleOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-sm p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Fecha de publicación (hora local)</p>
            <input
              type="datetime-local"
              className="input-field mb-3 min-h-10"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={() => void schedulePost()}>Confirmar</button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setScheduleOpen(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
