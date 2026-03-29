"use client";

import { useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

export default function DashboardHome() {
  const [counts, setCounts] = useState({ accounts: 0, leads: 0, tasks: 0 });

  useEffect(() => {
    (async () => {
      if (!(await getValidAccessToken())) return;
      try {
        const [a, l, t] = await Promise.all([
          api<{ accounts: unknown[] }>("/linkedin-accounts"),
          api<{ leads: unknown[] }>("/leads"),
          api<{ tasks: unknown[] }>("/tasks"),
        ]);
        setCounts({ accounts: a.accounts.length, leads: l.leads.length, tasks: t.tasks.length });
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Resumen</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Cuentas LinkedIn", n: counts.accounts },
          { label: "Leads", n: counts.leads },
          { label: "Tareas (recientes)", n: counts.tasks },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-white/10 bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--muted)]">{c.label}</p>
            <p className="text-3xl font-semibold">{c.n}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 max-w-xl text-sm text-[var(--muted)]">
        Añade proxies residenciales, conecta la cookie <code className="text-[var(--text)]">li_at</code>, importa leads y
        define campañas. El worker en el VPS ejecuta la cola Redis con Playwright (máx. 4 navegadores).
      </p>
    </div>
  );
}
