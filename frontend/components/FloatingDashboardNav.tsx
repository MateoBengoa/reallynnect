"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

const nav = [
  { href: "/dashboard", label: "Inicio", match: (p: string) => p === "/dashboard" },
  { href: "/dashboard/campaigns", label: "Campañas", match: (p: string) => p.startsWith("/dashboard/campaigns") },
  { href: "/dashboard/leads", label: "Leads", match: (p: string) => p.startsWith("/dashboard/leads") },
  { href: "/dashboard/inbox", label: "Inbox", match: (p: string) => p.startsWith("/dashboard/inbox") },
  { href: "/dashboard/calendar", label: "Calendario", match: (p: string) => p.startsWith("/dashboard/calendar") },
  { href: "/dashboard/content", label: "Contenido", match: (p: string) => p.startsWith("/dashboard/content") },
  { href: "/dashboard/tasks", label: "Tareas", match: (p: string) => p.startsWith("/dashboard/tasks") },
] as const;

function displayName(user: User | null): string {
  if (!user) return "Usuario";
  const m = user.user_metadata as Record<string, unknown> | undefined;
  const full = m?.full_name ?? m?.name;
  if (typeof full === "string" && full.trim()) return full.trim();
  if (user.email) return user.email.split("@")[0] ?? "Usuario";
  return "Usuario";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "?";
}

type FloatingDashboardNavProps = {
  onLogout: () => void;
};

const navLinkBase =
  "link-focus inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors";
const navLinkActive = "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]";
const navLinkIdle = "text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-[var(--text)]";

export function FloatingDashboardNav({ onLogout }: FloatingDashboardNavProps) {
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreNavOpen, setMoreNavOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const menuRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    setTheme(isLight ? "light" : "dark");
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!menuOpen && !moreNavOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (dockRef.current && !dockRef.current.contains(t)) setMoreNavOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setMoreNavOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen, moreNavOpen]);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("dashboard-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("dashboard-theme");
    }
  }, [theme]);

  const name = displayName(user);
  const email = user?.email ?? "";

  const primaryVisible = nav.slice(0, 3);
  const secondaryNav = nav.slice(3);

  return (
    <div
      ref={dockRef}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <div className="pointer-events-auto relative flex w-full max-w-4xl flex-col items-center">
        <nav className="nav-dock flex w-full max-w-3xl items-center gap-1 px-2 py-2 sm:gap-1.5 sm:px-3" aria-label="Principal">
          <Link
            href="/dashboard"
            className="link-focus mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent)] text-white shadow-[var(--shadow-sm)]"
            aria-label="Inicio"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
            </svg>
          </Link>

          <span className="hidden h-6 w-px shrink-0 bg-[var(--border)] sm:block" aria-hidden />

          {/* Desktop: todos los items — solo desde xl para que quepan los 7 */}
          <div className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 xl:flex">
            {nav.map((item) => {
              const active = item.match(path);
              return (
                <Link key={item.href} href={item.href} className={`${navLinkBase} px-2.5 text-[13px] ${active ? navLinkActive : navLinkIdle}`}>
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Tablet (md–xl): primeros 5 items + "Más" dropdown para los restantes */}
          <div className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex xl:hidden">
            {nav.slice(0, 5).map((item) => {
              const active = item.match(path);
              return (
                <Link key={item.href} href={item.href} className={`${navLinkBase} px-2.5 text-[13px] ${active ? navLinkActive : navLinkIdle}`}>
                  {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              aria-expanded={moreNavOpen}
              aria-haspopup="menu"
              onClick={() => setMoreNavOpen((o) => !o)}
              className={`${navLinkBase} px-2.5 text-[13px] ${moreNavOpen || nav.slice(5).some((i) => i.match(path)) ? navLinkActive : navLinkIdle}`}
            >
              Más
            </button>
          </div>

          {/* Mobile: primeros 3 + "Más" */}
          <div
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto md:hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {primaryVisible.map((item) => {
              const active = item.match(path);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`link-focus inline-flex min-h-10 shrink-0 items-center rounded-[var(--radius-md)] px-2.5 text-[11px] font-medium ${
                    active ? navLinkActive : navLinkIdle
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              aria-expanded={moreNavOpen}
              aria-haspopup="menu"
              onClick={() => setMoreNavOpen((o) => !o)}
              className={`link-focus inline-flex min-h-10 shrink-0 items-center rounded-[var(--radius-md)] px-2.5 text-[11px] font-medium ${
                moreNavOpen || secondaryNav.some((i) => i.match(path)) ? navLinkActive : navLinkIdle
              }`}
            >
              Más
            </button>
          </div>

          <span className="hidden h-6 w-px shrink-0 bg-[var(--border)] sm:block" aria-hidden />

          <button
            type="button"
            onClick={toggleTheme}
            className="link-focus flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-[var(--text)]"
            aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"}
          >
            {theme === "dark" ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            )}
          </button>

          <Link
            href="/dashboard/campaigns#nueva-campana"
            className="link-focus btn-primary hidden shrink-0 sm:inline-flex"
          >
            <span className="text-lg leading-none">+</span>
            <span className="hidden lg:inline">Nuevo proyecto</span>
          </Link>

          <Link
            href="/dashboard/campaigns#nueva-campana"
            className="link-focus flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent)] text-lg font-semibold text-white shadow-[var(--shadow-sm)] sm:hidden"
            aria-label="Nuevo proyecto"
          >
            +
          </Link>

          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="link-focus flex items-center rounded-full p-0.5 hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--text)] text-xs font-semibold text-[var(--bg)] ring-2 ring-[color-mix(in_srgb,var(--border)_100%,transparent)]">
                {initials(name)}
              </span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="popover-panel absolute right-0 top-full z-50 mt-2 w-[min(calc(100vw-1.5rem),17rem)] py-2"
              >
                <div className="border-b border-[var(--border)] px-3 pb-3 pt-1">
                  <p className="truncate font-semibold text-[var(--text)]">{name}</p>
                  {email && <p className="truncate text-xs text-[var(--muted)]">{email}</p>}
                </div>
                <Link
                  href="/dashboard/settings"
                  role="menuitem"
                  className="link-focus mx-1 mt-1 flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-sm text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg className="h-4 w-4 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.75}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Configuración
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  className="link-focus mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm text-red-500 hover:bg-[color-mix(in_srgb,#ef4444_12%,transparent)]"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                >
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.75}
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                  Cerrar sesión
                </button>
              </div>
            )}
          </div>
        </nav>

        {moreNavOpen && (
          <div
            role="menu"
            className="popover-panel absolute top-full z-50 mt-2 w-[min(calc(100vw-1.5rem),22rem)] py-2"
          >
            <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Navegación</p>
            {/* Móvil (<md): items 3-6 | Tablet (md-xl): solo items 5-6 | xl+: no se muestra el dropdown */}
            {nav.map((item, idx) => {
              const active = item.match(path);
              // En móvil mostrar desde idx 3; en tablet desde idx 5
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={() => setMoreNavOpen(false)}
                  className={`link-focus mx-1 rounded-[var(--radius-md)] px-3 py-2.5 text-sm ${
                    idx < 3 ? "hidden" : idx < 5 ? "block md:hidden" : "block xl:hidden"
                  } ${active ? navLinkActive : "text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
