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
      <h1 className="page-title mb-4">Proxies (Webshare)</h1>
      <form onSubmit={add} className="card card-pad mb-8 grid max-w-lg gap-3 sm:grid-cols-2">
        <input
          className="input-field sm:col-span-2"
          placeholder="Host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          required
        />
        <input
          type="number"
          className="input-field"
          placeholder="Puerto"
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
        />
        <input
          className="input-field"
          placeholder="Usuario (opcional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          className="input-field sm:col-span-2"
          placeholder="Contraseña proxy"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <p className="text-sm text-red-400 sm:col-span-2">{err}</p>}
        <button type="submit" className="btn-primary sm:col-span-2">
          Añadir proxy
        </button>
      </form>
      <ul className="space-y-2">
        {list.map((p) => (
          <li key={p.id} className="card card-pad flex justify-between py-2 text-sm shadow-none">
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
