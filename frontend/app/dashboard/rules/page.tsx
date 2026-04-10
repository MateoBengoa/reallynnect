"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";

type Rule = {
  id: string;
  keyword: string;
  reply_template: string;
  rule_type: string;
  use_ai: boolean;
  account_id: string | null;
  post_id: string | null;
  dm_followup_template: string | null;
  dm_followup_use_ai: boolean;
};

type Account = { id: string; li_display_name: string | null };
type Post = { id: string; content: string; status: string };

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [keyword, setKeyword] = useState("");
  const [template, setTemplate] = useState("Hola {name}, gracias por tu interés.");
  const [ruleType, setRuleType] = useState<"dm" | "comment">("dm");
  const [useAi, setUseAi] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [postId, setPostId] = useState("");
  const [dmFollowup, setDmFollowup] = useState("");
  const [dmFollowupAi, setDmFollowupAi] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [r, acc, po] = await Promise.all([
      api<{ rules: Rule[] }>("/keyword-rules"),
      api<{ accounts: Account[] }>("/linkedin-accounts"),
      api<{ posts: Post[] }>("/posts"),
    ]);
    setRules(r.rules);
    setAccounts(acc.accounts);
    setPosts(po.posts);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditingId(null);
    setKeyword("");
    setTemplate("Hola {name}, gracias por tu interés.");
    setRuleType("dm");
    setUseAi(false);
    setAccountId("");
    setPostId("");
    setDmFollowup("");
    setDmFollowupAi(false);
  }

  function startEdit(rule: Rule) {
    setEditingId(rule.id);
    setKeyword(rule.keyword);
    setTemplate(rule.reply_template);
    setRuleType(rule.rule_type as "dm" | "comment");
    setUseAi(rule.use_ai);
    setAccountId(rule.account_id ?? "");
    setPostId(rule.post_id ?? "");
    setDmFollowup(rule.dm_followup_template ?? "");
    setDmFollowupAi(rule.dm_followup_use_ai);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    const body = {
      keyword,
      reply_template: template,
      rule_type: ruleType,
      use_ai: useAi,
      account_id: accountId || null,
      post_id: postId || null,
      dm_followup_template: dmFollowup.trim() || null,
      dm_followup_use_ai: dmFollowupAi,
    };
    if (editingId) {
      await api(`/keyword-rules/${editingId}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await api("/keyword-rules", { method: "POST", body: JSON.stringify(body) });
    }
    resetForm();
    await load();
  }

  async function remove(id: string) {
    if (!(await getValidAccessToken())) return;
    await api(`/keyword-rules/${id}`, { method: "DELETE" });
    if (editingId === id) resetForm();
    await load();
  }

  return (
    <div>
      <h1 className="page-title mb-4">Reglas por palabra clave</h1>
      <p className="page-desc mb-4">
        Las reglas tipo <strong>DM</strong> se evalúan al abrir un hilo en Inbox (sincronización del chat).{" "}
        <code className="text-[var(--text)]">poll_comments</code> (programado por el worker) usa tipo comentario. Ola B: opcionalmente filtra por cuenta
        y por post (tras publicar, el post guarda URL en LinkedIn para acotar notificaciones). DM de seguimiento tras comentar
        es opcional.
      </p>
      <form onSubmit={submit} className="card card-pad mb-8 max-w-xl space-y-3">
        {editingId && (
          <p className="text-xs text-[var(--accent)]">
            Editando regla <span className="font-mono">{editingId.slice(0, 8)}…</span>{" "}
            <button type="button" className="ml-2 underline" onClick={resetForm}>
              Cancelar edición
            </button>
          </p>
        )}
        <input
          className="input-field"
          placeholder="Palabra (ej. pricing)"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          required
        />
        <textarea
          className="input-field min-h-[80px] py-2 text-sm"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          required
        />
        <select
          className="input-field min-h-[2.5rem] py-2"
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as "dm" | "comment")}
        >
          <option value="dm">DM</option>
          <option value="comment">Comentario (notificaciones)</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
          Usar Gemini para la respuesta en hilo
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Cuenta (opcional)</span>
            <select
              className="input-field min-h-[2.5rem] py-2"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Todas las cuentas</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.li_display_name ?? a.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-[var(--muted)]">Post (opcional, comentarios)</span>
            <select
              className="input-field min-h-[2.5rem] py-2"
              value={postId}
              onChange={(e) => setPostId(e.target.value)}
            >
              <option value="">Cualquier post</option>
              {posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.status} · {p.content.slice(0, 36)}…
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-[var(--muted)]">DM de seguimiento tras comentar (opcional)</span>
          <textarea
            className="input-field min-h-[60px] py-2 text-sm"
            placeholder="Texto del mensaje directo…"
            value={dmFollowup}
            onChange={(e) => setDmFollowup(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dmFollowupAi} onChange={(e) => setDmFollowupAi(e.target.checked)} />
          Generar DM de seguimiento con Gemini
        </label>
        <button type="submit" className="btn-primary">
          {editingId ? "Guardar cambios" : "Añadir regla"}
        </button>
      </form>
      <ul className="space-y-2 text-sm">
        {rules.map((r) => (
          <li
            key={r.id}
            className="card card-pad flex flex-col gap-2 py-2 shadow-none sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <strong>{r.keyword}</strong> ({r.rule_type}) {r.use_ai ? "· IA" : ""}
              {r.account_id && <span className="text-[var(--muted)]"> · cuenta</span>}
              {r.post_id && <span className="text-[var(--muted)]"> · post</span>}
              {(r.dm_followup_template || r.dm_followup_use_ai) && (
                <span className="text-[var(--muted)]"> · DM seguimiento</span>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => startEdit(r)}>
                Editar
              </button>
              <button type="button" className="text-red-400 hover:underline" onClick={() => remove(r.id)}>
                Borrar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
