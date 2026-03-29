"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Lead = {
  id: string;
  profile_url: string;
  name: string | null;
  company: string | null;
  title: string | null;
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [url, setUrl] = useState("");
  const [bulk, setBulk] = useState("");

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ leads: Lead[] }>("/leads");
    setLeads(r.leads);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    await api("/leads", {
      method: "POST",
      body: JSON.stringify({ profile_url: url }),
    });
    setUrl("");
    await load();
  }

  async function importBulk(e: React.FormEvent) {
    e.preventDefault();
    const urls = bulk
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((u) => u.startsWith("http"));
    if (!urls.length) return;
    if (!(await getValidAccessToken())) return;
    await api("/leads/import", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
    setBulk("");
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Leads</h1>
      <form onSubmit={addOne} className="mb-4 flex max-w-xl gap-2">
        <input
          className="flex-1 rounded border border-white/10 bg-[var(--surface)] px-2 py-1.5 text-sm"
          placeholder="URL de perfil LinkedIn"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white">
          Añadir
        </button>
      </form>
      <form onSubmit={importBulk} className="mb-8 max-w-xl space-y-2">
        <textarea
          className="min-h-[120px] w-full rounded border border-white/10 bg-[var(--surface)] px-2 py-1.5 text-sm"
          placeholder="Una URL por línea"
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
        />
        <button type="submit" className="rounded-lg border border-white/20 px-3 py-1.5 text-sm">
          Importar lote
        </button>
      </form>
      <ul className="space-y-1 text-sm">
        {leads.map((l) => (
          <li key={l.id} className="truncate rounded border border-white/5 px-2 py-1">
            <a href={l.profile_url} className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
              {l.name ?? l.profile_url}
            </a>
            {l.title && <span className="text-[var(--muted)]"> · {l.title}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
