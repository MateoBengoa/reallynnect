"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const primaryNav = [
  {
    href: "/dashboard",
    label: "Inicio",
    match: (p: string) => p === "/dashboard",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/dashboard/campaigns",
    label: "Campañas",
    match: (p: string) => p.startsWith("/dashboard/campaigns"),
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    href: "/dashboard/inbox",
    label: "Inbox",
    match: (p: string) => p.startsWith("/dashboard/inbox"),
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
] as const;

const moreLinks = [
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/content", label: "Contenido" },
  { href: "/dashboard/settings", label: "Ajustes" },
  { href: "/dashboard/accounts", label: "Cuentas LinkedIn" },
  { href: "/dashboard/proxies", label: "Proxies" },
  { href: "/dashboard/tasks", label: "Tareas" },
  { href: "/dashboard/roadmap", label: "Roadmap" },
] as const;

function moreMenuActive(path: string): boolean {
  return moreLinks.some((l) => path === l.href || path.startsWith(l.href + "/"));
}

type FloatingDockProps = {
  onLogout: () => void;
};

export function FloatingDock({ onLogout }: FloatingDockProps) {
  const path = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  useEffect(() => {
    if (!moreOpen) return;
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [moreOpen]);

  return (
    <div
      ref={panelRef}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto mb-2 flex max-w-md flex-col items-center gap-2">
        {moreOpen && (
          <div
            role="menu"
            className="w-full min-w-[min(100vw-1.5rem,20rem)] rounded-2xl border border-white/10 bg-[var(--surface)] p-2 shadow-xl backdrop-blur-md"
          >
            <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Más</p>
            <ul className="flex max-h-[min(60vh,22rem)] flex-col gap-0.5 overflow-y-auto">
              {moreLinks.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    role="menuitem"
                    onClick={closeMore}
                    className={`block rounded-xl px-3 py-2.5 text-sm ${
                      path === l.href || path.startsWith(l.href + "/") ? "bg-white/10" : "hover:bg-white/5"
                    }`}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
              <li className="mt-1 border-t border-white/10 pt-1">
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded-xl px-3 py-2.5 text-left text-sm text-[var(--muted)] hover:bg-white/5"
                  onClick={() => {
                    closeMore();
                    onLogout();
                  }}
                >
                  Salir
                </button>
              </li>
            </ul>
          </div>
        )}

        <nav
          className="flex items-center justify-center gap-1 rounded-2xl border border-white/10 bg-[var(--surface)]/95 px-2 py-2 shadow-lg backdrop-blur-md sm:gap-2 sm:px-3"
          aria-label="Navegación principal"
        >
          {primaryNav.map((item) => {
            const active = item.match(path);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={`flex min-w-[3rem] flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 sm:min-w-[4.25rem] sm:px-3 ${
                  active ? "bg-[var(--accent)]/25 text-[var(--accent)]" : "text-[var(--muted)] hover:bg-white/5 hover:text-[var(--text)]"
                }`}
              >
                {item.icon}
                <span className="hidden text-[10px] font-medium sm:inline">{item.label}</span>
              </Link>
            );
          })}

          <button
            type="button"
            title="Más opciones"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((o) => !o)}
            className={`flex min-w-[3rem] flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 sm:min-w-[4.25rem] sm:px-3 ${
              moreOpen || moreMenuActive(path)
                ? "bg-[var(--accent)]/25 text-[var(--accent)]"
                : "text-[var(--muted)] hover:bg-white/5 hover:text-[var(--text)]"
            }`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <span className="hidden text-[10px] font-medium sm:inline">Más</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
