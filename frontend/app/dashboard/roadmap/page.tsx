"use client";

import Link from "next/link";

const waves = [
  {
    id: "A",
    title: "Ola A — Base",
    items: [
      "Inbox unificado y sync por cuenta",
      "Reglas / keywords DM bajo «Más» → Keywords",
      "Métricas en Inicio: campañas activas, tareas fallidas (últ. 100), etc.",
    ],
  },
  {
    id: "B",
    title: "Ola B — Inbound tipo LinkeMagnet",
    items: [
      "Reglas de comentario: filtro por cuenta y por post (URN/URL tras publicar)",
      "DM de seguimiento opcional tras responder en el hilo del comentario",
      "Log en API GET /inbound-comment-events y pestaña Posts → Inbound comentarios",
    ],
  },
  {
    id: "C",
    title: "Ola C — Marca personal",
    items: [
      "Borradores con IA o manual (POST /posts), edición PATCH en borrador",
      "Programación con tarea publish_post; guarda linkedin_activity_url/urn al publicar",
      "Pestañas en Posts: IA, manual, cola/calendario, inbound",
    ],
  },
  {
    id: "D",
    title: "Ola D — Escala tipo Prosp",
    items: [
      "Import CSV de leads con columnas (profile_url, name, company, title, source)",
      "Presupuestos diarios por cuenta + prioridad de rotación (menor = preferida en campañas)",
      "Webhooks salientes (PATCH /me) en task.completed y task.failed",
    ],
  },
] as const;

export default function RoadmapPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="page-title mb-2">Roadmap</h1>
      <p className="page-desc mb-6">
        Estado actual: olas A–D cubiertas en código; aplica la migración{" "}
        <code className="text-[var(--text)]">011_waves_b_c_d.sql</code> en Supabase para columnas y tabla de eventos. Navegación:
        cuatro accesos + «Más» (incluye Ajustes para webhooks).
      </p>
      <ol className="space-y-6">
        {waves.map((w) => (
          <li key={w.id} className="card card-pad">
            <p className="text-sm font-semibold text-[var(--text)]">{w.title}</p>
            <ul className="mt-2 list-inside list-disc text-sm text-[var(--muted)]">
              {w.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm text-[var(--muted)]">
        Volver al{" "}
        <Link href="/dashboard" className="link-focus rounded-sm text-[var(--accent)] underline-offset-2 hover:underline">
          resumen
        </Link>{" "}
        o a{" "}
        <Link href="/dashboard/campaigns" className="link-focus rounded-sm text-[var(--accent)] underline-offset-2 hover:underline">
          campañas
        </Link>
        .
      </p>
    </div>
  );
}
