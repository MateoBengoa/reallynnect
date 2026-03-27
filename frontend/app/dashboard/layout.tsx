"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const nav = [
  { href: "/dashboard", label: "Resumen" },
  { href: "/dashboard/proxies", label: "Proxies" },
  { href: "/dashboard/accounts", label: "LinkedIn" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/campaigns", label: "Campañas" },
  { href: "/dashboard/posts", label: "Posts" },
  { href: "/dashboard/rules", label: "Keywords" },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/tasks", label: "Tareas" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) router.replace("/login");
      else setReady(true);
    });
  }, [router]);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--muted)]">Cargando…</div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 border-r border-white/10 bg-[var(--surface)] p-4">
        <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Menú</p>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded px-2 py-1.5 text-sm ${path === n.href ? "bg-white/10" : "hover:bg-white/5"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <button
          type="button"
          onClick={logout}
          className="mt-6 w-full rounded border border-white/10 py-1.5 text-sm text-[var(--muted)] hover:bg-white/5"
        >
          Salir
        </button>
      </aside>
      <div className="flex-1 overflow-auto p-6">{children}</div>
    </div>
  );
}
