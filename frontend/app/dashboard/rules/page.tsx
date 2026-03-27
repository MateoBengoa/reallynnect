"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";

type Rule = {
  id: string;
  keyword: string;
  reply_template: string;
  rule_type: string;
  use_ai: boolean;
};

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [keyword, setKeyword] = useState("");
  const [template, setTemplate] = useState("Hola {name}, gracias por tu interés.");
  const [ruleType, setRuleType] = useState<"dm" | "comment">("dm");
  const [useAi, setUseAi] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const r = await api<{ rules: Rule[] }>("/keyword-rules", token);
    setRules(r.rules);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api("/keyword-rules", token, {
      method: "POST",
      body: JSON.stringify({ keyword, reply_template: template, rule_type: ruleType, use_ai: useAi }),
    });
    setKeyword("");
    await load();
  }

  async function remove(id: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await api(`/keyword-rules/${id}`, token, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Reglas por palabra clave</h1>
      <p className="mb-4 max-w-xl text-sm text-[var(--muted)]">
        El worker programa <code className="text-[var(--text)]">poll_messages</code> y{" "}
        <code className="text-[var(--text)]">poll_comments</code> de forma periódica. Si el texto coincide, se responde con
        la plantilla o con IA.
      </p>
      <form onSubmit={add} className="mb-8 max-w-xl space-y-3 rounded-xl border border-white/10 bg-[var(--surface)] p-4">
        <input
          className="w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5"
          placeholder="Palabra (ej. pricing)"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <textarea
          className="min-h-[80px] w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5 text-sm"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <select
          className="w-full rounded border border-white/10 bg-[var(--bg)] px-2 py-1.5"
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as "dm" | "comment")}
        >
          <option value="dm">DM</option>
          <option value="comment">Comentario</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
          Usar Gemini para la respuesta
        </label>
        <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-white">
          Añadir regla
        </button>
      </form>
      <ul className="space-y-2 text-sm">
        {rules.map((r) => (
          <li key={r.id} className="flex justify-between rounded border border-white/10 px-3 py-2">
            <span>
              <strong>{r.keyword}</strong> ({r.rule_type}) {r.use_ai ? "· IA" : ""}
            </span>
            <button type="button" className="text-red-400 hover:underline" onClick={() => remove(r.id)}>
              Borrar
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
