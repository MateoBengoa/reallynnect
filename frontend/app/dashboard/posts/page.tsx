"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";

type Post = {
  id: string;
  content: string;
  status: string;
  scheduled_time: string | null;
  image_url: string | null;
};

export default function PostsPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [topic, setTopic] = useState("");
  const [withImage, setWithImage] = useState(false);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ posts: Post[] }>("/posts", token);
    setPosts(r.posts);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api("/posts/generate", token, {
      method: "POST",
      body: JSON.stringify({ topic, with_image: withImage }),
    });
    setTopic("");
    await load();
  }

  async function schedule() {
    if (!scheduleId || !scheduleAt) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const iso = new Date(scheduleAt).toISOString();
    await api(`/posts/${scheduleId}/schedule`, token, {
      method: "POST",
      body: JSON.stringify({ scheduled_time: iso }),
    });
    setScheduleId(null);
    setScheduleAt("");
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Posts con IA</h1>
      <form onSubmit={generate} className="mb-8 max-w-xl space-y-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4">
        <input
          className="w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5"
          placeholder="Tema del post"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withImage} onChange={(e) => setWithImage(e.target.checked)} />
          Generar imagen (Gemini)
        </label>
        <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-white">
          Generar borrador
        </button>
      </form>
      <ul className="space-y-4">
        {posts.map((p) => (
          <li key={p.id} className="rounded-lg border border-white/10 p-3 text-sm">
            <p className="whitespace-pre-wrap text-[var(--text)]">{p.content.slice(0, 400)}…</p>
            <p className="mt-2 text-[var(--muted)]">
              {p.status} {p.scheduled_time && `· ${p.scheduled_time}`}
            </p>
            {p.status === "draft" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="text-[var(--accent)] hover:underline"
                  onClick={() => setScheduleId(p.id)}
                >
                  Programar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {scheduleId && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[var(--surface)] p-4">
            <p className="mb-2 font-medium">Fecha publicación (local)</p>
            <input
              type="datetime-local"
              className="mb-3 w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className="flex gap-2">
              <button type="button" className="flex-1 rounded bg-[var(--accent)] py-2 text-white" onClick={schedule}>
                Confirmar
              </button>
              <button type="button" className="flex-1 rounded border border-white/20 py-2" onClick={() => setScheduleId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
