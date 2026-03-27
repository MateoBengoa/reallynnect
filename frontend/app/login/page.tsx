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
    <main className="mx-auto flex max-w-md flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold">{mode === "login" ? "Iniciar sesión" : "Registro"}</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input
          className="rounded border border-white/10 bg-[var(--surface)] px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="rounded border border-white/10 bg-[var(--surface)] px-3 py-2"
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err && <p className="text-sm text-red-400">{err}</p>}
        <button type="submit" className="rounded-lg bg-[var(--accent)] py-2 font-medium text-white">
          Continuar
        </button>
      </form>
      <button
        type="button"
        className="text-sm text-[var(--muted)] underline"
        onClick={() => setMode(mode === "login" ? "signup" : "login")}
      >
        {mode === "login" ? "Crear cuenta" : "Ya tengo cuenta"}
      </button>
    </main>
  );
}
