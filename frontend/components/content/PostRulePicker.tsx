"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ContentPost } from "@/lib/contentTypes";

type PostRulePickerProps = {
  posts: ContentPost[];
  value: string;
  onChange: (postId: string) => void;
};

function previewText(s: string, max = 72) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function PostRulePicker({ posts, value, onChange }: PostRulePickerProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = value ? posts.find((p) => p.id === value) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => p.content.toLowerCase().includes(q) || p.status.toLowerCase().includes(q));
  }, [posts, query]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const pick = useCallback(
    (idNext: string) => {
      onChange(idNext);
      setOpen(false);
      setQuery("");
    },
    [onChange]
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="input-field flex min-h-[2.75rem] w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <>
              <span className="mr-2 inline-flex rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                {selected.status}
              </span>
              {previewText(selected.content, 56)}
            </>
          ) : (
            <span className="text-[var(--muted)]">Cualquier post</span>
          )}
        </span>
        <span className="shrink-0 text-[var(--muted)]" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          className="popover-panel absolute left-0 right-0 top-full z-[60] mt-1 flex max-h-[min(70vh,28rem)] flex-col overflow-hidden p-0 shadow-[var(--shadow-md)]"
        >
          <div className="border-b border-[var(--border)] p-2">
            <input
              ref={searchRef}
              type="search"
              className="input-field min-h-10 py-2 text-sm"
              placeholder="Buscar por texto o estado…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filtrar posts"
            />
          </div>
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={value === ""}
                onClick={() => pick("")}
                className={`w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-left text-sm transition-colors ${
                  value === ""
                    ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))]"
                    : "border-transparent hover:bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))]"
                }`}
              >
                <span className="font-medium text-[var(--text)]">Cualquier post</span>
                <p className="mt-0.5 text-xs text-[var(--muted)]">La regla aplica sin filtrar por publicación concreta.</p>
              </button>
            </li>
            {filtered.map((p) => {
              const active = p.id === value;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => pick(p.id)}
                    className={`w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-left text-sm transition-colors ${
                      active
                        ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))]"
                        : "border-transparent hover:bg-[color-mix(in_srgb,var(--text)_5%,var(--surface))]"
                    }`}
                  >
                    <span className="inline-flex rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                      {p.status}
                    </span>
                    {p.scheduled_time && (
                      <span className="ml-2 text-[10px] text-[var(--muted)]">{p.scheduled_time}</span>
                    )}
                    <p className="mt-1.5 line-clamp-3 text-[var(--text)]">{p.content}</p>
                  </button>
                </li>
              );
            })}
          </ul>
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-[var(--muted)]">Ningún post coincide con la búsqueda.</p>
          )}
        </div>
      )}
    </div>
  );
}
