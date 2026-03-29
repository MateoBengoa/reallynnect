"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

export default function DashboardHome() {
  const [counts, setCounts] = useState({
    accounts: 0,
    leads: 0,
    tasksRecent: 0,
    tasksFailed: 0,
    campaignsActive: 0,
  });

  useEffect(() => {
    (async () => {
      if (!(await getValidAccessToken())) return;
      try {
        const [a, l, t, c] = await Promise.all([
          api<{ accounts: unknown[] }>("/linkedin-accounts"),
          api<{ leads: unknown[] }>("/leads"),
          api<{ tasks: { status?: string }[] }>("/tasks"),
          api<{ campaigns: { status?: string }[] }>("/campaigns"),
        ]);
        const failed = (t.tasks ?? []).filter((x) => x.status === "failed").length;
        const active = (c.campaigns ?? []).filter((x) => x.status === "active").length;
        setCounts({
          accounts: a.accounts.length,
          leads: l.leads.length,
          tasksRecent: t.tasks.length,
          tasksFailed: failed,
          campaignsActive: active,
        });
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const cards = [
    { label: "Cuentas LinkedIn", n: counts.accounts },
    { label: "Leads", n: counts.leads },
    { label: "Campañas activas", n: counts.campaignsActive },
    { label: "Tareas fallidas (últ. 100)", n: counts.tasksFailed },
    { label: "Tareas recientes", n: counts.tasksRecent },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Resumen</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-white/10 bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--muted)]">{c.label}</p>
            <p className="text-3xl font-semibold">{c.n}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 max-w-xl text-sm text-[var(--muted)]">
        Añade proxies residenciales, conecta la cookie <code className="text-[var(--text)]">li_at</code>, importa leads y define
        campañas como flujo en el lienzo. El worker ejecuta la cola con Playwright.
      </p>
      <p className="mt-4 text-sm">
        <Link href="/dashboard/roadmap" className="text-[var(--accent)] underline-offset-2 hover:underline">
          Ver roadmap de próximas olas (inbound, contenido, escala)
        </Link>
      </p>
    </div>
  );
}
