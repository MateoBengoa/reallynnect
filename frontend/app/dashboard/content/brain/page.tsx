"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Brain = {
  company_name: string;
  description:  string;
  products:     string;
  audience:     string;
  tone:         string;
  value_prop:   string;
  keywords:     string;
  extra:        string;
};

const EMPTY: Brain = {
  company_name: "",
  description:  "",
  products:     "",
  audience:     "",
  tone:         "",
  value_prop:   "",
  keywords:     "",
  extra:        "",
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
        <input
          className="input-field text-sm"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(name, e.target.value)}
        />
      ) : (
        <textarea
          className="input-field resize-y py-2.5 text-sm leading-relaxed"
          style={{ minHeight: `${rows * 1.6}rem` }}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(name, e.target.value)}
        />
      )}
      {hint && <p className="mt-1 text-[11px] text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

export default function BrainPage() {
  const [brain, setBrain] = useState<Brain>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    try {
      const { brain: b } = await api<{ brain: Brain | null }>("/brain");
      if (b) setBrain({ ...EMPTY, ...b });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function update(k: keyof Brain, v: string) {
    setBrain((prev) => ({ ...prev, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setSaveOk(false);
    setError(null);
    try {
      if (!(await getValidAccessToken())) return;
      await api("/brain", { method: "PATCH", body: JSON.stringify(brain) });
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const filled = Object.values(brain).filter(Boolean).length;
  const pct = Math.round((filled / 8) * 100);

  return (
    <div className="min-w-0 pb-16">
      <Link
        href="/dashboard/content"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">←</span>
        Volver a Contenido
      </Link>

      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface))] text-[var(--accent)]">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
              <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
            </svg>
          </div>
          <div>
            <h1 className="page-title">Cerebro del negocio</h1>
            <p className="page-desc mt-0.5">Esta información se usa automáticamente al generar posts con IA.</p>
          </div>
        </div>

        {/* Barra de completitud */}
        {!loading && (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text)_10%,var(--border))]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium text-[var(--muted)]">{pct}% completo</span>
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Col 1 */}
          <div className="space-y-5">
            <div className="card px-4 py-4 space-y-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Empresa</p>
              <Field
                label="Nombre de la empresa"
                name="company_name"
                value={brain.company_name}
                onChange={update}
                placeholder="Ej. Reallynnect"
                rows={1}
              />
              <Field
                label="Qué hace tu negocio"
                name="description"
                value={brain.description}
                onChange={update}
                placeholder="Describe en 2-3 frases qué hace la empresa, su misión y el problema que resuelve."
                rows={4}
              />
              <Field
                label="Productos / servicios"
                name="products"
                value={brain.products}
                onChange={update}
                placeholder="Lista los productos o servicios principales y qué los diferencia."
                rows={3}
              />
            </div>

            <div className="card px-4 py-4 space-y-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Audiencia</p>
              <Field
                label="Audiencia objetivo"
                name="audience"
                value={brain.audience}
                onChange={update}
                placeholder="Ej. Fundadores B2B de SaaS con equipos de ventas de 5-20 personas que quieren automatizar LinkedIn."
                rows={3}
              />
              <Field
                label="Propuesta de valor única"
                name="value_prop"
                value={brain.value_prop}
                onChange={update}
                placeholder="¿Por qué te eligen a ti y no a la competencia?"
                rows={3}
              />
            </div>
          </div>

          {/* Col 2 */}
          <div className="space-y-5">
            <div className="card px-4 py-4 space-y-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Voz y estilo</p>
              <Field
                label="Tono de comunicación"
                name="tone"
                value={brain.tone}
                onChange={update}
                placeholder="Ej. Directo y profesional, sin jerga corporativa. Pensamiento de liderazgo con datos reales. Primera persona."
                rows={3}
              />
              <Field
                label="Palabras clave y hashtags"
                name="keywords"
                value={brain.keywords}
                onChange={update}
                placeholder="Ej. automatización LinkedIn, prospección B2B, ventas outbound, #SaaS #Ventas #LinkedIn"
                rows={3}
                hint="Aparecerán naturalmente en los posts generados."
              />
            </div>

            <div className="card px-4 py-4 space-y-4">
              <p className="text-[0.7rem] font-bold uppercase tracking-widest text-[var(--accent)]">Contexto extra</p>
              <Field
                label="Información adicional"
                name="extra"
                value={brain.extra}
                onChange={update}
                placeholder="Casos de éxito, testimonios, datos propios, temas que quieres evitar, competidores, logros recientes…"
                rows={5}
              />
            </div>

            {/* Guardar */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={saving}
                className="btn-primary min-h-10 min-w-[10rem] disabled:opacity-50"
                onClick={() => void save()}
              >
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
              {error && <span className="text-sm text-[#fca5a5]">{error}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
