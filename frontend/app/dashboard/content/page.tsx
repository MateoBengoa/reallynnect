import Link from "next/link";

/** Alto del área útil = viewport − padding del layout dashboard (pt/pb + safe areas). Sin min-h en tarjetas: reparten el espacio y evitan scroll. */
const hubViewportH =
  "h-[calc(100dvh-4.25rem-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-h-[calc(100dvh-4.25rem-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:h-[calc(100dvh-4.5rem-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:max-h-[calc(100dvh-4.5rem-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]";

export default function ContentHubPage() {
  return (
    <div className={`flex flex-col gap-4 overflow-hidden ${hubViewportH}`}>
      <div className="shrink-0">
        <h1 className="page-title mb-1">Contenido</h1>
        <p className="page-desc max-w-2xl leading-snug sm:leading-normal">
          Gestiona publicaciones en LinkedIn y las automatizaciones por palabras clave (DM y comentarios) desde dos áreas claras.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
        <Link
          href="/dashboard/content/posts"
          className="group card flex min-h-0 flex-1 flex-col justify-between overflow-hidden p-5 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] hover:shadow-[var(--shadow-md)] sm:p-6"
        >
          <div className="min-h-0">
            <div className="mb-4 flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] sm:h-14 sm:w-14">
              <svg className="h-6 w-6 sm:h-7 sm:w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-[var(--text)] group-hover:text-[var(--accent)] sm:text-2xl">
              Posts
            </h2>
            <p className="mt-2 line-clamp-3 max-w-md text-sm leading-snug text-[var(--muted)] sm:mt-3 sm:text-base sm:leading-relaxed">
              Borradores con IA o manual, cola y programación, e historial de eventos inbound de comentarios.
            </p>
          </div>
          <span className="mt-3 shrink-0 text-sm font-semibold text-[var(--accent)] sm:mt-4 sm:text-base">Entrar →</span>
        </Link>

        <Link
          href="/dashboard/content/brain"
          className="group card flex min-h-0 flex-1 flex-col justify-between overflow-hidden p-5 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] hover:shadow-[var(--shadow-md)] sm:p-6"
        >
          <div className="min-h-0">
            <div className="mb-4 flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] sm:h-14 sm:w-14">
              <svg className="h-6 w-6 sm:h-7 sm:w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-[var(--text)] group-hover:text-[var(--accent)] sm:text-2xl">
              Cerebro
            </h2>
            <p className="mt-2 line-clamp-3 max-w-md text-sm leading-snug text-[var(--muted)] sm:mt-3 sm:text-base sm:leading-relaxed">
              Contexto del negocio: empresa, audiencia, tono y propuesta de valor. La IA lo usa para personalizar cada post.
            </p>
          </div>
          <span className="mt-3 shrink-0 text-sm font-semibold text-[var(--accent)] sm:mt-4 sm:text-base">Configurar →</span>
        </Link>

        <Link
          href="/dashboard/content/automations"
          className="group card flex min-h-0 flex-1 flex-col justify-between overflow-hidden p-5 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_28%,var(--border))] hover:shadow-[var(--shadow-md)] sm:p-6"
        >
          <div className="min-h-0">
            <div className="mb-4 flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)] sm:h-14 sm:w-14">
              <svg className="h-6 w-6 sm:h-7 sm:w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-[var(--text)] group-hover:text-[var(--accent)] sm:text-2xl">
              Configuración y automatizaciones
            </h2>
            <p className="mt-2 line-clamp-3 max-w-md text-sm leading-snug text-[var(--muted)] sm:mt-3 sm:text-base sm:leading-relaxed">
              Reglas por palabra clave para mensajes y comentarios, con filtros por cuenta y post publicado.
            </p>
          </div>
          <span className="mt-3 shrink-0 text-sm font-semibold text-[var(--accent)] sm:mt-4 sm:text-base">Entrar →</span>
        </Link>
      </div>
    </div>
  );
}
