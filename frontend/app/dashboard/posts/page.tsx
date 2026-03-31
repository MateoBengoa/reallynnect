"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Post = {
  id: string;
  content: string;
  status: string;
  scheduled_time: string | null;
  image_url: string | null;
  linkedin_activity_url?: string | null;
  linkedin_activity_urn?: string | null;
  account_id: string;
};

type Account = { id: string; li_display_name: string | null };

type InboundEvent = {
  id: string;
  event_type: string;
  created_at: string;
  detail: Record<string, unknown> | null;
};

type Tab = "ai" | "manual" | "queue" | "inbound";

export default function PostsPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [tab, setTab] = useState<Tab>("ai");
  const [topic, setTopic] = useState("");
  const [withImage, setWithImage] = useState(false);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const [manualAccount, setManualAccount] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [r, acc] = await Promise.all([
      api<{ posts: Post[] }>("/posts"),
      api<{ accounts: Account[] }>("/linkedin-accounts"),
    ]);
    setPosts(r.posts);
    setAccounts(acc.accounts);
  }, []);

  const loadInbound = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const r = await api<{ events: InboundEvent[] }>("/inbound-comment-events");
    setEvents(r.events);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (accounts.length > 0 && !manualAccount) setManualAccount(accounts[0]!.id);
  }, [accounts, manualAccount]);

  useEffect(() => {
    if (tab === "inbound") loadInbound();
  }, [tab, loadInbound]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    await api("/posts/generate", {
      method: "POST",
      body: JSON.stringify({ topic, with_image: withImage }),
    });
    setTopic("");
    await load();
  }

  async function createManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualAccount || !manualContent.trim()) return;
    if (!(await getValidAccessToken())) return;
    await api("/posts", {
      method: "POST",
      body: JSON.stringify({ account_id: manualAccount, content: manualContent.trim() }),
    });
    setManualContent("");
    await load();
    setTab("queue");
  }

  async function schedule() {
    if (!scheduleId || !scheduleAt) return;
    if (!(await getValidAccessToken())) return;
    const iso = new Date(scheduleAt).toISOString();
    await api(`/posts/${scheduleId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduled_time: iso }),
    });
    setScheduleId(null);
    setScheduleAt("");
    await load();
  }

  async function saveEdit() {
    if (!editId || !editContent.trim()) return;
    if (!(await getValidAccessToken())) return;
    await api(`/posts/${editId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: editContent.trim() }),
    });
    setEditId(null);
    await load();
  }

  const drafts = posts.filter((p) => p.status === "draft");
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const published = posts.filter((p) => p.status === "published");

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={`tab-pill text-sm ${tab === id ? "tab-pill-active" : ""}`}
    >
      {label}
    </button>
  );

  function postCard(p: Post) {
    return (
      <li key={p.id} className="card card-pad py-3 text-sm shadow-none">
        <p className="whitespace-pre-wrap text-[var(--text)]">{p.content.slice(0, 500)}{p.content.length > 500 ? "…" : ""}</p>
        <p className="mt-2 text-[var(--muted)]">
          {p.status}
          {p.scheduled_time && ` · ${p.scheduled_time}`}
        </p>
        {p.linkedin_activity_url && (
          <a
            href={p.linkedin_activity_url}
            className="mt-1 inline-block text-[var(--accent)] hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Ver en LinkedIn
          </a>
        )}
        {p.status === "draft" && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => setScheduleId(p.id)}>
              Programar
            </button>
            <button
              type="button"
              className="text-[var(--muted)] hover:underline"
              onClick={() => {
                setEditId(p.id);
                setEditContent(p.content);
              }}
            >
              Editar borrador
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div>
      <h1 className="page-title mb-2">Posts</h1>
      <div className="tabs-pill mb-6 w-fit max-w-full flex-wrap">
        {tabBtn("ai", "IA")}
        {tabBtn("manual", "Borrador manual")}
        {tabBtn("queue", "Cola / calendario")}
        {tabBtn("inbound", "Inbound comentarios")}
      </div>

      {tab === "ai" && (
        <form onSubmit={generate} className="card card-pad mb-8 max-w-xl space-y-3">
          <input
            className="input-field"
            placeholder="Tema del post"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} />
            Generar imagen (Gemini)
          </label>
          <button type="submit" className="btn-primary">
            Generar borrador
          </button>
        </form>
      )}

      {tab === "manual" && (
        <form onSubmit={createManual} className="card card-pad mb-8 max-w-xl space-y-3">
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Cuenta</span>
            <select
              className="input-field min-h-[2.5rem] py-2"
              value={manualAccount}
              onChange={(e) => setManualAccount(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.li_display_name ?? a.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <textarea
            className="input-field min-h-[140px] py-2 text-sm"
            placeholder="Texto del post…"
            value={manualContent}
            onChange={(e) => setManualContent(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary">
            Guardar borrador
          </button>
        </form>
      )}

      {tab === "queue" && (
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--muted)]">Programados</h2>
            <ul className="space-y-4">{scheduled.map(postCard)}</ul>
            {scheduled.length === 0 && <p className="text-sm text-[var(--muted)]">Nada programado.</p>}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--muted)]">Borradores</h2>
            <ul className="space-y-4">{drafts.map(postCard)}</ul>
            {drafts.length === 0 && <p className="text-sm text-[var(--muted)]">Sin borradores.</p>}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--muted)]">Publicados</h2>
            <ul className="space-y-4">{published.map(postCard)}</ul>
            {published.length === 0 && <p className="text-sm text-[var(--muted)]">Aún no hay publicaciones registradas.</p>}
          </section>
        </div>
      )}

      {tab === "inbound" && (
        <div className="max-w-2xl">
          <p className="mb-4 text-sm text-[var(--muted)]">
            Eventos generados por <code className="text-[var(--text)]">poll_comments</code> (respuesta pública y DM opcional).
          </p>
          <ul className="space-y-2 text-sm">
            {events.map((ev) => (
              <li key={ev.id} className="card card-pad px-3 py-2 shadow-none">
                <span className="font-medium text-[var(--text)]">{ev.event_type}</span>
                <span className="text-[var(--muted)]"> · {new Date(ev.created_at).toLocaleString("es")}</span>
                {ev.detail && (
                  <pre className="mt-1 max-h-24 overflow-auto text-xs text-[var(--muted)]">
                    {JSON.stringify(ev.detail, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
          {events.length === 0 && <p className="text-sm text-[var(--muted)]">Sin eventos aún.</p>}
        </div>
      )}

      {tab !== "queue" && tab !== "inbound" && (
        <ul className="space-y-4">
          {drafts.slice(0, 6).map(postCard)}
        </ul>
      )}

      {scheduleId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-sm p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Fecha publicación (local)</p>
            <input
              type="datetime-local"
              className="input-field mb-3 min-h-10"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={schedule}>
                Confirmar
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setScheduleId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="popover-panel w-full max-w-lg p-4">
            <p className="mb-2 font-medium text-[var(--text)]">Editar borrador</p>
            <textarea
              className="input-field mb-3 min-h-[200px] py-2 text-sm"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={saveEdit}>
                Guardar
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
