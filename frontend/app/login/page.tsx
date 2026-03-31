"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) return setErr(error.message);
      router.push("/dashboard");
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setErr(error.message);
    router.push("/dashboard");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 sm:p-8">
      <div className="card w-full max-w-md card-pad sm:p-8">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--accent)] text-white shadow-[var(--shadow-sm)]">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
            </svg>
          </div>
          <h1 className="page-title text-center">{mode === "login" ? "Iniciar sesión" : "Crear cuenta"}</h1>
          <p className="page-desc mx-auto mt-2 text-center">
            {mode === "login" ? "Accede al panel de automatización LinkedIn." : "Regístrate para comenzar."}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label htmlFor="login-email" className="text-xs font-medium text-[var(--muted)]">
              Email
            </label>
            <input
              id="login-email"
              className="input-field"
              type="email"
              placeholder="tu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-xs font-medium text-[var(--muted)]">
              Contraseña
            </label>
            <input
              id="login-password"
              className="input-field"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {err && (
            <p className="rounded-[var(--radius-md)] border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{err}</p>
          )}
          <button type="submit" className="btn-primary mt-2 w-full">
            Continuar
          </button>
        </form>

        <div className="mt-6 border-t border-[var(--border)] pt-6 text-center">
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => {
              setErr(null);
              setMode(mode === "login" ? "signup" : "login");
            }}
          >
            {mode === "login" ? "Crear cuenta nueva" : "Ya tengo cuenta"}
          </button>
        </div>
      </div>
    </main>
  );
}
