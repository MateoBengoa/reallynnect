"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type BrandType = "company" | "personal";

type Brain = {
  brand_type:     BrandType;
  company_name:   string;
  description:    string;
  products:       string;
  audience:       string;
  tone:           string;
  value_prop:     string;
  keywords:       string;
  extra:          string;
  full_name:      string;
  personal_role:  string;
  personal_story: string;
};

type BrainPhoto = {
  id: string;
  url: string;
  label: string;
  created_at: string;
};

const EMPTY: Brain = {
  brand_type: "personal", company_name: "", description: "", products: "",
  audience: "", tone: "", value_prop: "", keywords: "", extra: "",
  full_name: "", personal_role: "", personal_story: "",
};

const labelCap = "block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] mb-1.5";

function Field({
  label, name, value, onChange, placeholder, rows = 3, hint,
}: {
  label: string; name: keyof Brain; value: string;
  onChange: (k: keyof Brain, v: string) => void;
  placeholder?: string; rows?: number; hint?: string;
}) {
  return (
    <div>
      <label className={labelCap}>{label}</label>
      {rows === 1 ? (
        <input className="input-field text-sm" value={value} placeholder={placeholder}
          onChange={(e) => onChange(name, e.target.value)} />
      ) : (
        <textarea className="input-field resize-y py-2.5 text-sm leading-relaxed"
          style={{ minHeight: `${rows * 1.65}rem` }} value={value} placeholder={placeholder}
          onChange={(e) => onChange(name, e.target.value)} />
      )}
      {hint && <p className="mt-1 text-[11px] text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

const PERSONAL_FIELDS: (keyof Brain)[] = ["full_name", "personal_role", "personal_story", "audience", "tone", "value_prop", "keywords", "extra"];
const COMPANY_FIELDS:  (keyof Brain)[] = ["company_name", "description", "products", "audience", "tone", "value_prop", "keywords", "extra"];

function countFilled(b: Brain) {
  const fields = b.brand_type === "personal" ? PERSONAL_FIELDS : COMPANY_FIELDS;
  return fields.filter((k) => b[k].trim()).length;
}

export default function BrainPage() {
  const [brain, setBrain]     = useState<Brain>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saveOk, setSaveOk]   = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Fotos
  const [photos, setPhotos]           = useState<BrainPhoto[]>([]);
  const [uploading, setUploading]     = useState(false);
  const [uploadErr, setUploadErr]     = useState<string | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    try {
      const [{ brain: b }, { photos: p }] = await Promise.all([
        api<{ brain: Brain | null }>("/brain"),
        api<{ photos: BrainPhoto[] }>("/brain/photos"),
      ]);
      if (b) setBrain({ ...EMPTY, ...b });
      setPhotos(p ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function update(k: keyof Brain, v: string) {
    setBrain((prev) => ({ ...prev, [k]: v }));
  }

  function setMode(m: BrandType) {
    setBrain((prev) => ({ ...prev, brand_type: m }));
  }

  async function save() {
    setSaving(true); setSaveOk(false); setSaveErr(null);
    try {
      if (!(await getValidAccessToken())) return;
      await api("/brain", { method: "PATCH", body: JSON.stringify(brain) });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhoto(file: File) {
    setUploading(true); setUploadErr(null);
    try {
      if (!(await getValidAccessToken())) return;
      const fd = new FormData();
      fd.append("file", file);
      // Llamar directamente para enviar FormData (api() serializa JSON)
      const res = await fetch("/api/brain/photos", {
        method: "POST",
        headers: { Authorization: `Bearer ${await getBearer()}` },
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? res.statusText);
      }
      const { photo } = await res.json() as { photo: BrainPhoto };
      setPhotos((prev) => [photo, ...prev]);
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function deletePhoto(id: string) {
    setDeletingId(id);
    try {
      if (!(await getValidAccessToken())) return;
      await api(`/brain/photos/${id}`, { method: "DELETE" });
      setPhotos((prev) => prev.filter((p) => p.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  const filled = countFilled(brain);
  const total  = brain.brand_type === "personal" ? PERSONAL_FIELDS.length : COMPANY_FIELDS.length;
  const pct    = Math.round((filled / total) * 100);
  const isPersonal = brain.brand_type === "personal";

  return (
    <div className="min-w-0 pb-16">
      <Link href="/dashboard/content"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]">
        <span aria-hidden className="text-base leading-none">←</span>
        Volver a Contenido
      </Link>

      {/* Header */}
      <header className="mb-7">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface))] text-[var(--accent)]">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
              <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
            </svg>
          </div>
          <div>
            <h1 className="page-title">Cerebro</h1>
            <p className="page-desc mt-0.5">La IA usa esta info para personalizar cada post generado.</p>
          </div>
        </div>

        {/* Toggle empresa / marca personal */}
        <div className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))] p-1 w-fit">
          {(["personal", "company"] as BrandType[]).map((m) => (
            <button key={m} type="button"
              onClick={() => setMode(m)}
              className={`rounded-[calc(var(--radius-md)-2px)] px-4 py-1.5 text-sm font-medium transition-colors ${
                brain.brand_type === m
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {m === "personal" ? "Marca personal" : "Empresa"}
            </button>
          ))}
        </div>

        {/* Barra completitud */}
        {!loading && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1.5 flex-1 max-w-xs overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text)_10%,var(--border))]">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs font-medium text-[var(--muted)]">{filled}/{total} campos completados</span>
          </div>
        )}
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <svg className="h-6 w-6 animate-spin text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
          </svg>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Col 1 */}
            <div className="space-y-5">
              {isPersonal ? (
                <div className="card px-4 py-4 space-y-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Tu identidad</p>
                  <Field label="Tu nombre completo" name="full_name" value={brain.full_name} onChange={update}
                    placeholder="Ej. Mateo Bengoa" rows={1} />
                  <Field label="Título / rol" name="personal_role" value={brain.personal_role} onChange={update}
                    placeholder="Ej. Fundador de Reallynnect · Automatización LinkedIn para B2B" rows={1} />
                  <Field label="Tu historia / trayectoria" name="personal_story" value={brain.personal_story} onChange={update}
                    placeholder="¿Qué te llevó a hacer lo que haces? ¿Qué problema viviste en carne propia? Escribe en primera persona." rows={5} />
                </div>
              ) : (
                <div className="card px-4 py-4 space-y-4">
                  <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">La empresa</p>
                  <Field label="Nombre" name="company_name" value={brain.company_name} onChange={update}
                    placeholder="Ej. Reallynnect" rows={1} />
                  <Field label="Qué hace y por qué existe" name="description" value={brain.description} onChange={update}
                    placeholder="Describe en 2-3 frases la misión, el problema que resuelve y cómo lo hace." rows={4} />
                  <Field label="Productos / servicios" name="products" value={brain.products} onChange={update}
                    placeholder="Lista lo que ofrecés y qué diferencia a cada uno." rows={3} />
                </div>
              )}

              <div className="card px-4 py-4 space-y-4">
                <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Audiencia</p>
                <Field label="A quién le hablás" name="audience" value={brain.audience} onChange={update}
                  placeholder="Ej. Fundadores B2B con equipos de ventas de 5-20 personas que quieren generar leads en LinkedIn sin gastar en ads." rows={3} />
                <Field label="Propuesta de valor única" name="value_prop" value={brain.value_prop} onChange={update}
                  placeholder="¿Por qué te eligen a vos y no a la competencia?" rows={3} />
              </div>
            </div>

            {/* Col 2 */}
            <div className="space-y-5">
              <div className="card px-4 py-4 space-y-4">
                <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Voz y estilo</p>
                <Field label="Tono de comunicación" name="tone" value={brain.tone} onChange={update}
                  placeholder={isPersonal
                    ? "Ej. Directo, sin filtros, comparto lo que aprendí equivocándome. Primera persona. Datos reales."
                    : "Ej. Profesional pero accesible. Sin jerga corporativa. Thought leadership con ejemplos concretos."}
                  rows={3} />
                <Field label="Keywords y hashtags" name="keywords" value={brain.keywords} onChange={update}
                  placeholder="Ej. LinkedIn automation, B2B outbound, #SaaS #Ventas #LinkedIn"
                  hint="Aparecerán de forma natural en los posts." rows={3} />
              </div>

              <div className="card px-4 py-4 space-y-4">
                <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Contexto extra</p>
                <Field label="Casos de éxito, datos propios, temas a evitar…" name="extra" value={brain.extra} onChange={update}
                  placeholder={isPersonal
                    ? "Logros recientes, aprendizajes clave, frases que usás seguido, lo que NO querés sonar…"
                    : "Clientes destacados, resultados reales, competidores, posicionamiento frente a alternativas…"}
                  rows={5} />
              </div>

              {/* Guardar */}
              <div className="flex items-center gap-3">
                <button type="button" disabled={saving}
                  className="btn-primary min-h-10 min-w-[10rem] disabled:opacity-50"
                  onClick={() => void save()}>
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      Guardando…
                    </span>
                  ) : "Guardar cerebro"}
                </button>
                {saveOk && (
                  <span className="flex items-center gap-1.5 text-sm text-[#86efac]">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Guardado
                  </span>
                )}
                {saveErr && <span className="text-sm text-[#fca5a5]">{saveErr}</span>}
              </div>
            </div>
          </div>

          {/* ─── Fotos ─────────────────────────────────────────────────── */}
          <div className="card px-4 py-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">
                  {isPersonal ? "Tus fotos" : "Fotos de la marca"}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {isPersonal
                    ? "Subí fotos tuyas para usar en posts. La IA sabrá que tenés material propio."
                    : "Subí fotos del equipo, producto u oficina para personalizar los posts."}
                </p>
              </div>
              <button type="button"
                disabled={uploading}
                className="btn-secondary min-h-9 text-sm shrink-0 disabled:opacity-50"
                onClick={() => fileRef.current?.click()}>
                {uploading ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                    </svg>
                    Subiendo…
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Subir foto
                  </span>
                )}
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPhoto(f); e.target.value = ""; }} />
            </div>

            {uploadErr && <p className="mb-3 text-xs text-[#fca5a5]">{uploadErr}</p>}

            {photos.length === 0 ? (
              <button type="button"
                className="flex w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_30%,var(--border))] py-10 text-center text-[var(--muted)] transition-colors hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] hover:text-[var(--accent)]"
                onClick={() => fileRef.current?.click()}>
                <svg className="h-8 w-8 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18M12 6.75h.008v.008H12V6.75z" />
                </svg>
                <span className="text-sm">Arrastrá o hacé click para subir una foto</span>
                <span className="text-xs opacity-60">JPG, PNG, WEBP — máx. 8 MB</span>
              </button>
            ) : (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                {photos.map((p) => (
                  <div key={p.id} className="group relative aspect-square overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                    <img src={p.url} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      disabled={deletingId === p.id}
                      onClick={() => void deletePhoto(p.id)}
                      className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-100"
                    >
                      {deletingId === p.id ? (
                        <svg className="h-5 w-5 animate-spin text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
                        </svg>
                      ) : (
                        <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Helper para obtener el Bearer token actual
async function getBearer(): Promise<string> {
  const { supabase } = await import("@/lib/supabase");
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}
