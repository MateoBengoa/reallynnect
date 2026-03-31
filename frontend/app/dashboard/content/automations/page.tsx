"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import { PostRulePicker } from "@/components/content/PostRulePicker";
import type { ContentAccount, ContentPost, KeywordRule } from "@/lib/contentTypes";

const labelCap = "block text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]";

function postPreview(posts: ContentPost[], id: string | null, max = 48) {
  if (!id) return null;
  const p = posts.find((x) => x.id === id);
  if (!p) return "Post…";
  const t = p.content.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function ruleIsActive(r: KeywordRule): boolean {
  return r.is_active !== false;
}

export default function ContentAutomationsPage() {
  const [posts, setPosts] = useState<ContentPost[]>([]);
  const [rules, setRules] = useState<KeywordRule[]>([]);
  const [accounts, setAccounts] = useState<ContentAccount[]>([]);

  const [composerOpen, setComposerOpen] = useState(false);

  const [keyword, setKeyword] = useState("");
  const [template, setTemplate] = useState("Hola {name}, gracias por tu interés.");
  const [ruleType, setRuleType] = useState<"dm" | "comment">("dm");
  const [useAi, setUseAi] = useState(false);
  const [formActive, setFormActive] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [postId, setPostId] = useState("");
  const [dmFollowup, setDmFollowup] = useState("");
  const [dmFollowupAi, setDmFollowupAi] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const accountById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    const [po, acc, rul] = await Promise.all([
      api<{ posts: ContentPost[] }>("/posts"),
      api<{ accounts: ContentAccount[] }>("/linkedin-accounts"),
      api<{ rules: KeywordRule[] }>("/keyword-rules"),
    ]);
    setPosts(po.posts);
    setAccounts(acc.accounts);
    setRules(rul.rules);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetRuleForm() {
    setEditingId(null);
    setKeyword("");
    setTemplate("Hola {name}, gracias por tu interés.");
    setRuleType("dm");
    setUseAi(false);
    setFormActive(true);
    setAccountId("");
    setPostId("");
    setDmFollowup("");
    setDmFollowupAi(false);
  }

  function openCreateComposer() {
    resetRuleForm();
    setComposerOpen(true);
  }

  function closeComposer() {
    setComposerOpen(false);
    resetRuleForm();
  }

  function startEditRule(rule: KeywordRule) {
    setEditingId(rule.id);
    setKeyword(rule.keyword);
    setTemplate(rule.reply_template);
    setRuleType(rule.rule_type as "dm" | "comment");
    setUseAi(rule.use_ai);
    setFormActive(ruleIsActive(rule));
    setAccountId(rule.account_id ?? "");
    setPostId(rule.post_id ?? "");
    setDmFollowup(rule.dm_followup_template ?? "");
    setDmFollowupAi(rule.dm_followup_use_ai);
    setComposerOpen(true);
  }

  async function submitRule(e: React.FormEvent) {
    e.preventDefault();
    if (!(await getValidAccessToken())) return;
    const body = {
      keyword,
      reply_template: template,
      rule_type: ruleType,
      use_ai: useAi,
      is_active: formActive,
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
    resetRuleForm();
    setComposerOpen(false);
    await load();
  }

  async function removeRule(id: string) {
    if (!(await getValidAccessToken())) return;
    await api(`/keyword-rules/${id}`, { method: "DELETE" });
    if (editingId === id) {
      resetRuleForm();
      setComposerOpen(false);
    }
    await load();
  }

  async function toggleRuleActive(r: KeywordRule) {
    if (!(await getValidAccessToken())) return;
    const next = !ruleIsActive(r);
    await api(`/keyword-rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ is_active: next }) });
    await load();
  }

  return (
    <div className="min-w-0">
      <Link
        href="/dashboard/content"
        className="link-focus mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:text-[var(--text)]"
      >
        <span aria-hidden className="text-base leading-none">
          ←
        </span>
        Volver a Contenido
      </Link>

      <header className="mb-8 max-w-3xl">
        <h1 className="page-title mb-2">Configuración y automatizaciones</h1>
        <p className="page-desc leading-relaxed">
          Activa respuestas cuando alguien escribe una palabra clave por mensaje o en un comentario. Pausa reglas sin borrarlas.
        </p>
      </header>

      <h2 className={`${labelCap} mb-3`}>Tus reglas</h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={openCreateComposer}
          className="group flex min-h-[11rem] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_38%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-4 py-8 text-center transition-[border-color,background-color,box-shadow] hover:border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_45%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        >
          <span
            className="flex h-12 w-12 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)] transition-transform group-hover:scale-105"
            aria-hidden
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </span>
          <span className="text-base font-semibold text-[var(--text)]">Crear nueva regla</span>
          <span className="max-w-[14rem] text-xs leading-snug text-[var(--muted)]">
            Define palabra clave, respuesta y canal; opcionalmente IA y alcance.
          </span>
        </button>

        {rules.map((r) => {
          const active = ruleIsActive(r);
          return (
            <article
              key={r.id}
              className={`card flex min-h-[11rem] flex-col overflow-hidden shadow-[var(--shadow-sm)] transition-opacity ${
                active ? "" : "opacity-[0.88]"
              }`}
            >
              <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-3 sm:px-4">
                <h3 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-[var(--text)]">{r.keyword}</h3>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                    active
                      ? "border border-[color-mix(in_srgb,#22c55e_40%,var(--border))] bg-[color-mix(in_srgb,#22c55e_14%,var(--surface))] text-[#86efac]"
                      : "border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_6%,var(--surface))] text-[var(--muted)]"
                  }`}
                >
                  {active ? "Activa" : "Inactiva"}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-3 card-pad pt-3">
                <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-[var(--muted)]">{r.reply_template}</p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))] px-2 py-0.5 text-[11px] font-medium text-[var(--text)]">
                    {r.rule_type === "dm" ? "DM" : "Comentario"}
                  </span>
                  {r.use_ai && (
                    <span className="inline-flex rounded-md border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                      Gemini
                    </span>
                  )}
                  {r.account_id && (
                    <span className="inline-flex max-w-full truncate rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
                      {accountById[r.account_id]?.li_display_name ?? r.account_id.slice(0, 8)}
                    </span>
                  )}
                  {r.post_id && (
                    <span
                      className="inline-flex max-w-full truncate rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
                      title={postPreview(posts, r.post_id) ?? ""}
                    >
                      {postPreview(posts, r.post_id) ?? "Post"}
                    </span>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                  <button type="button" className="btn-secondary min-h-9 flex-1 text-sm" onClick={() => startEditRule(r)}>
                    Editar
                  </button>
                  <button type="button" className="btn-secondary min-h-9 flex-1 text-sm" onClick={() => toggleRuleActive(r)}>
                    {active ? "Pausar" : "Activar"}
                  </button>
                  <button type="button" className="btn-danger min-h-9 flex-1 text-sm" onClick={() => removeRule(r.id)}>
                    Borrar
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {composerOpen && (
        <form onSubmit={submitRule} className="card mb-10 flex min-w-0 max-w-3xl flex-col overflow-hidden shadow-[var(--shadow-md)]">
          <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] px-4 py-4 sm:px-5 sm:py-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-[var(--text)] sm:text-lg">
                  {editingId ? "Editar regla" : "Nueva regla"}
                </h2>
                <p className="mt-1 text-xs leading-snug text-[var(--muted)] sm:text-[0.8125rem]">
                  Usa{" "}
                  <code className="rounded bg-[color-mix(in_srgb,var(--text)_8%,transparent)] px-1 py-0.5 font-mono text-[0.7rem] text-[var(--text)]">{`{name}`}</code>{" "}
                  en el texto para el nombre del contacto.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className="btn-ghost min-h-9 px-3 text-sm" onClick={closeComposer}>
                  Cerrar
                </button>
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--accent)_18%,var(--surface))] text-[var(--accent)]"
                  aria-hidden
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                    />
                  </svg>
                </div>
              </div>
            </div>
            {editingId && (
              <p className="mt-2 text-xs text-[var(--accent)]">
                <span className="font-mono opacity-90">{editingId.slice(0, 8)}…</span>
              </p>
            )}
          </div>

          <div className="card-pad flex flex-col gap-6 sm:gap-7">
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-3.5 py-3">
              <span className="text-sm font-medium text-[var(--text)]">Regla activa (el worker la aplicará)</span>
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-[var(--border)] accent-[var(--accent)]"
              />
            </label>

            <div>
              <span className={`${labelCap} mb-2`}>Canal</span>
              <div
                className="flex rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_4%,var(--bg))] p-1"
                role="group"
                aria-label="Tipo de regla"
              >
                <button
                  type="button"
                  onClick={() => setRuleType("dm")}
                  className={`flex-1 rounded-[var(--radius-md)] py-2.5 text-sm font-medium transition-[color,background,box-shadow] ${
                    ruleType === "dm"
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  Mensaje directo
                </button>
                <button
                  type="button"
                  onClick={() => setRuleType("comment")}
                  className={`flex-1 rounded-[var(--radius-md)] py-2.5 text-sm font-medium transition-[color,background,box-shadow] ${
                    ruleType === "comment"
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  Comentario
                </button>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                DM: bandeja de mensajes. Comentario: notificaciones de comentarios en tus publicaciones.
              </p>
            </div>

            <div>
              <label className={`${labelCap} mb-2`} htmlFor="rule-keyword">
                Palabra clave
              </label>
              <input
                id="rule-keyword"
                className="input-field text-sm"
                placeholder="Ej. pricing, demo, info"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                required
                autoComplete="off"
              />
            </div>

            <div>
              <label className={`${labelCap} mb-2`} htmlFor="rule-template">
                Respuesta
              </label>
              <textarea
                id="rule-template"
                className="input-field min-h-[88px] resize-y py-2.5 text-sm leading-relaxed"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                required
                placeholder="Texto que se enviará o publicará…"
              />
            </div>

            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))] p-4 sm:p-5">
              <span className={`${labelCap} mb-3`}>Alcance (opcional)</span>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--text)]">Cuenta de LinkedIn</span>
                  <select
                    className="input-field min-h-[2.5rem] w-full py-2 text-sm"
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
                <div className="min-w-0">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--text)]">Post publicado</span>
                  <PostRulePicker posts={posts} value={postId} onChange={setPostId} />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <span className={`${labelCap} mb-2`}>Inteligencia artificial</span>
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-3.5 py-3 transition-colors hover:bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))]">
                <span className="text-sm text-[var(--text)]">Generar respuesta con Gemini en el hilo</span>
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-[var(--border)] accent-[var(--accent)]"
                />
              </label>
            </div>

            <div className="space-y-3 border-t border-[var(--border)] pt-6">
              <span className={labelCap}>Tras comentar (opcional)</span>
              <p className="-mt-1 text-xs text-[var(--muted)]">
                Si encaja la regla por comentario, puedes enviar un DM de seguimiento automático.
              </p>
              <label htmlFor="rule-dm-followup" className="sr-only">
                Mensaje de seguimiento por DM
              </label>
              <textarea
                id="rule-dm-followup"
                className="input-field min-h-[64px] resize-y py-2.5 text-sm"
                placeholder="Mensaje de seguimiento por DM…"
                value={dmFollowup}
                onChange={(e) => setDmFollowup(e.target.value)}
              />
              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-3.5 py-3 transition-colors hover:bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))]">
                <span className="text-sm text-[var(--text)]">DM de seguimiento con Gemini</span>
                <input
                  type="checkbox"
                  checked={dmFollowupAi}
                  onChange={(e) => setDmFollowupAi(e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-[var(--border)] accent-[var(--accent)]"
                />
              </label>
            </div>
          </div>

          <div className="card-footer flex w-full flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] !justify-between">
            <button type="button" className="btn-ghost min-h-9" onClick={closeComposer}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary min-w-[10rem]">
              {editingId ? "Guardar cambios" : "Añadir regla"}
            </button>
          </div>
        </form>
      )}

      <p className="mt-6 max-w-2xl text-[0.6875rem] leading-relaxed text-[var(--muted)]">
        Las reglas inactivas no las usa el worker en mensajes ni en comentarios hasta que las reactives.
      </p>
    </div>
  );
}
