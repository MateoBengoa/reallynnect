"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getValidAccessToken } from "@/lib/supabase";
import { api } from "@/lib/api";
import type { ContentPost, ContentAccount } from "@/lib/contentTypes";

const STATUS_COLOR: Record<string, string> = {
  draft:     "bg-[color-mix(in_srgb,var(--muted)_60%,var(--border))]",
  scheduled: "bg-[var(--accent)]",
  published: "bg-[#22c55e]",
  failed:    "bg-[#ef4444]",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador", scheduled: "Programado", published: "Publicado", failed: "Error",
};

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function startOfMonth(y: number, m: number) { return new Date(y, m, 1); }
function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
// Monday-first: Mon=0 … Sun=6
function weekday(d: Date) { return (d.getDay() + 6) % 7; }

export default function CalendarPage() {
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [posts, setPosts]     = useState<ContentPost[]>([]);
  const [accounts, setAccounts] = useState<ContentAccount[]>([]);
  const [selected, setSelected] = useState<number | null>(null); // day number
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!(await getValidAccessToken())) return;
    setLoading(true);
    try {
      const [{ posts: p }, { accounts: a }] = await Promise.all([
        api<{ posts: ContentPost[] }>("/posts"),
        api<{ accounts: ContentAccount[] }>("/linkedin-accounts"),
      ]);
      setPosts(p ?? []);
      setAccounts(a ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const accountById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a])),
    [accounts]
  );

  // Agrupa posts por fecha ISO "YYYY-MM-DD" usando scheduled_time
  const postsByDay = useMemo(() => {
    const map: Record<string, ContentPost[]> = {};
    for (const p of posts) {
      const t = p.scheduled_time;
      if (!t) continue;
      const key = t.slice(0, 10); // "YYYY-MM-DD"
      (map[key] ??= []).push(p);
    }
    return map;
  }, [posts]);

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
    setSelected(null);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
    setSelected(null);
  }

  const firstDay   = weekday(startOfMonth(year, month)); // 0=Mon
  const totalDays  = daysInMonth(year, month);
  const totalCells = Math.ceil((firstDay + totalDays) / 7) * 7;

  const selectedKey = selected
    ? `${year}-${String(month + 1).padStart(2, "0")}-${String(selected).padStart(2, "0")}`
    : null;
  const selectedPosts = selectedKey ? (postsByDay[selectedKey] ?? []) : [];

  // Posts del mes para el resumen
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthPosts  = posts.filter((p) => p.scheduled_time?.startsWith(monthPrefix));

  return (
    <div className="min-w-0 pb-16">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Calendario</h1>
          <p className="page-desc">Posts programados y publicados.</p>
        </div>
        <Link href="/dashboard/content/posts" className="btn-secondary min-h-9 text-sm">
          + Nuevo post
        </Link>
      </header>

      {/* Leyenda */}
      <div className="mb-4 flex flex-wrap gap-3">
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[k]}`} />
            {v}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Calendario */}
        <div className="card overflow-hidden">
          {/* Nav mes */}
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <button type="button" onClick={prevMonth}
              className="btn-ghost min-h-8 px-2.5 text-sm">‹</button>
            <h2 className="text-base font-semibold text-[var(--text)]">
              {MONTHS[month]} {year}
            </h2>
            <button type="button" onClick={nextMonth}
              className="btn-ghost min-h-8 px-2.5 text-sm">›</button>
          </div>

          {/* Cabecera días */}
          <div className="grid grid-cols-7 border-b border-[var(--border)]">
            {DAYS.map((d) => (
              <div key={d} className="py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                {d}
              </div>
            ))}
          </div>

          {/* Grid */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="h-5 w-5 animate-spin text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            </div>
          ) : (
            <div className="grid grid-cols-7">
              {Array.from({ length: totalCells }).map((_, i) => {
                const day = i - firstDay + 1;
                const valid = day >= 1 && day <= totalDays;
                const key = valid
                  ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                  : null;
                const dayPosts = key ? (postsByDay[key] ?? []) : [];
                const isToday = valid && day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                const isSelected = valid && day === selected;

                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!valid}
                    onClick={() => valid && setSelected(day === selected ? null : day)}
                    className={`min-h-[4.5rem] border-b border-r border-[var(--border)] p-1.5 text-left transition-colors
                      ${!valid ? "bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))]" : ""}
                      ${isSelected ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))]" : valid ? "hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--surface))]" : ""}
                    `}
                  >
                    {valid && (
                      <>
                        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium
                          ${isToday ? "bg-[var(--accent)] text-white" : "text-[var(--text)]"}
                        `}>
                          {day}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-0.5">
                          {dayPosts.slice(0, 4).map((p) => (
                            <span key={p.id} className={`h-1.5 w-1.5 rounded-full ${STATUS_COLOR[p.status] ?? "bg-[var(--muted)]"}`} />
                          ))}
                          {dayPosts.length > 4 && (
                            <span className="text-[9px] text-[var(--muted)]">+{dayPosts.length - 4}</span>
                          )}
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Panel lateral */}
        <div className="space-y-4">
          {/* Resumen del mes */}
          <div className="card px-4 py-4">
            <p className="mb-3 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              {MONTHS[month]}
            </p>
            {monthPosts.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Sin posts este mes.</p>
            ) : (
              <div className="space-y-1.5">
                {(["scheduled", "published", "draft", "failed"] as const).map((s) => {
                  const n = monthPosts.filter((p) => p.status === s).length;
                  if (!n) return null;
                  return (
                    <div key={s} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-[var(--muted)]">
                        <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[s]}`} />
                        {STATUS_LABEL[s]}
                      </span>
                      <span className="font-semibold tabular-nums text-[var(--text)]">{n}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Posts del día seleccionado */}
          {selected && (
            <div className="card px-4 py-4">
              <p className="mb-3 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                {selected} de {MONTHS[month]}
              </p>
              {selectedPosts.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">Sin posts este día.</p>
              ) : (
                <div className="space-y-3">
                  {selectedPosts.map((p) => {
                    const acc = accountById[p.account_id];
                    const name = acc?.li_display_name ?? `Cuenta ${p.account_id.slice(0, 6)}`;
                    const time = p.scheduled_time
                      ? new Date(p.scheduled_time).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
                      : null;
                    return (
                      <Link key={p.id} href={`/dashboard/content/posts/${p.id}`}
                        className="block rounded-[var(--radius-md)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text)_2%,var(--surface))] px-3 py-2.5 transition-colors hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--border))]">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-[var(--text)]">{name}</span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            p.status === "published" ? "bg-[color-mix(in_srgb,#22c55e_14%,var(--surface))] text-[#86efac]" :
                            p.status === "scheduled" ? "bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-[var(--accent)]" :
                            "bg-[color-mix(in_srgb,var(--text)_8%,var(--surface))] text-[var(--muted)]"
                          }`}>
                            {STATUS_LABEL[p.status] ?? p.status}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">{p.content}</p>
                        {time && <p className="mt-1 text-[10px] text-[var(--muted)]">{time}</p>}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
