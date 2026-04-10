"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

const nav = [
  { href: "/dashboard", label: "Inicio", match: (p: string) => p === "/dashboard" },
  { href: "/dashboard/content", label: "Contenido", match: (p: string) => p.startsWith("/dashboard/content") },
  { href: "/dashboard/campaigns", label: "Campañas", match: (p: string) => p.startsWith("/dashboard/campaigns") },
  { href: "/dashboard/leads", label: "Leads", match: (p: string) => p.startsWith("/dashboard/leads") },
  { href: "/dashboard/inbox", label: "Inbox", match: (p: string) => p.startsWith("/dashboard/inbox") },
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

type DashboardNavbarProps = {
  onLogout: () => void;
};

export function DashboardNavbar({ onLogout }: DashboardNavbarProps) {
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const menuRef = useRef<HTMLDivElement>(null);

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
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

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

  return (
    <header
      className="sticky top-0 z-50 border-b border-[var(--border)] backdrop-blur-md"
      style={{ backgroundColor: "var(--navbar-bg)" }}
    >
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-3 sm:h-16 sm:gap-4 sm:px-4 lg:px-6">
        <Link
          href="/dashboard"
          className="flex shrink-0 items-center gap-2 rounded-lg outline-none ring-[var(--accent)] focus-visible:ring-2"
          aria-label="Inicio"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-sm">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
            </svg>
          </span>
          <span className="hidden font-semibold text-[var(--text)] sm:inline">LinkedIn</span>
        </Link>

        <nav className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex lg:gap-1" aria-label="Principal">
          {nav.map((item) => {
            const active = item.match(path);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition-colors lg:px-3 ${
                  active ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--border)] hover:text-[var(--text)]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto md:hidden" aria-label="Principal móvil">
          {nav.map((item) => {
            const active = item.match(path);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium ${
                  active ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--muted)]"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--border)] hover:text-[var(--text)]"
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
            className="hidden items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 sm:inline-flex"
          >
            <span className="text-lg leading-none">+</span>
            Nuevo proyecto
          </Link>

          <Link
            href="/dashboard/campaigns#nueva-campana"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-lg font-semibold text-white sm:hidden"
            aria-label="Nuevo proyecto"
          >
            +
          </Link>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2 outline-none ring-[var(--accent)] hover:bg-[var(--border)] focus-visible:ring-2 sm:pr-2"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text)] text-sm font-semibold text-[var(--bg)]">
                {initials(name)}
              </span>
              <svg className="hidden h-4 w-4 text-[var(--muted)] sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+0.5rem)] w-[min(calc(100vw-1.5rem),16rem)] rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_32%,transparent)] py-2 shadow-xl"
              >
                <div className="border-b border-[var(--border)] px-3 pb-3 pt-1">
                  <p className="truncate font-semibold text-[var(--text)]">{name}</p>
                  {email && <p className="truncate text-xs text-[var(--muted)]">{email}</p>}
                </div>
                <Link
                  href="/dashboard/settings"
                  role="menuitem"
                  className="flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text)] hover:bg-[var(--border)]"
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
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-red-500 hover:bg-red-500/10"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
        </div>
      </div>
    </header>
  );
}
