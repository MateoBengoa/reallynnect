import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">LinkedIn Automation</h1>
      <p className="text-[var(--muted)]">Panel multi-usuario: cola Redis, Playwright y Supabase.</p>
      <Link
        href="/login"
        className="rounded-lg bg-[var(--accent)] px-4 py-2 text-center font-medium text-white hover:opacity-90"
      >
        Entrar
      </Link>
    </main>
  );
}
