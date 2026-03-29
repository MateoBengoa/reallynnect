"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Proxy = {
  id: string;
  host: string;
  port: number;
  username: string | null;
  status: string;
  last_used: string | null;
};

export default function ProxiesPage() {
  const [list, setList] = useState<Proxy[]>([]);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(80);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ proxies: Proxy[] }>("/proxies");
    setList(r.proxies);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!(await getValidAccessToken())) return;
    try {
      await api("/proxies", {
        method: "POST",
        body: JSON.stringify({
          host,
          port,
          username: username || undefined,
          password: password || undefined,
        }),
      });
      setHost("");
      setPassword("");
      await load();
    } catch (e2: unknown) {
      setErr(e2 instanceof Error ? e2.message : "Error");
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Proxies (Webshare)</h1>
      <form onSubmit={add} className="mb-8 grid max-w-lg gap-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4 sm:grid-cols-2">
        <input
          className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5 sm:col-span-2"
          placeholder="Host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          required
        />
        <input
          type="number"
          className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5"
          placeholder="Puerto"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
        />
        <input
          className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5"
          placeholder="Usuario (opcional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          className="rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5 sm:col-span-2"
          placeholder="Contraseña proxy"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <p className="text-sm text-red-400 sm:col-span-2">{err}</p>}
        <button type="submit" className="rounded-lg bg-[var(--accent)] py-2 font-medium text-white sm:col-span-2">
          Añadir proxy
        </button>
      </form>
      <ul className="space-y-2">
        {list.map((p) => (
          <li key={p.id} className="flex justify-between rounded-lg border border-white/10 px-3 py-2 text-sm">
            <span>
              {p.host}:{p.port} {p.username ? `(${p.username})` : ""}
            </span>
            <span className="text-[var(--muted)]">{p.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
