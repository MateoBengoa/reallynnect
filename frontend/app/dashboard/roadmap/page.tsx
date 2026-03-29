"use client";

import Link from "next/link";

const waves = [
  {
    id: "A",
    title: "Ola A — Base (ya encaminada)",
    items: [
      "Inbox unificado y sync por cuenta",
      "Reglas / keywords DM bajo «Más» → Keywords",
      "Métricas mínimas en Inicio (próximo: campañas activas, tareas fallidas)",
    ],
  },
  {
    id: "B",
    title: "Ola B — Inbound tipo LinkeMagnet",
    items: [
      "Triggers por comentario en tus posts (palabra clave → DM / tarea)",
      "Detección en worker (poll o webhook según arquitectura)",
      "UX: pestaña o bloque dentro de Posts",
    ],
    next: true,
  },
  {
    id: "C",
    title: "Ola C — Marca personal tipo Linked360",
    items: [
      "Cola de publicaciones programadas + encolar publish_post",
      "Sugerencias de contenido con IA (opcional)",
    ],
  },
  {
    id: "D",
    title: "Ola D — Escala tipo Prosp",
    items: [
      "Import / enriquecimiento de leads",
      "Límites y rotación multi-cuenta visibles en UI",
      "Webhooks salientes e integraciones",
    ],
  },
] as const;

export default function RoadmapPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold">Roadmap</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Prioridad sugerida para el mix outbound + inbox + inbound por contenido, sin recargar el dock: una iniciativa grande por
        sprint. La navegación principal sigue en cuatro accesos + «Más».
      </p>
      <ol className="space-y-6">
        {waves.map((w) => (
          <li
            key={w.id}
            className={`rounded-xl border p-4 ${"next" in w && w.next ? "border-[var(--accent)]/40 bg-[var(--accent)]/5" : "border-white/10 bg-[var(--surface)]"}`}
          >
            <p className="text-sm font-semibold text-[var(--text)]">
              {w.title}
              {"next" in w && w.next ? (
                <span className="ml-2 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--accent)]">
                  Siguiente foco
                </span>
              ) : null}
            </p>
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
        <Link href="/dashboard" className="text-[var(--accent)] underline-offset-2 hover:underline">
          resumen
        </Link>{" "}
        o a{" "}
        <Link href="/dashboard/campaigns" className="text-[var(--accent)] underline-offset-2 hover:underline">
          campañas
        </Link>
        .
      </p>
    </div>
  );
}
