"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FloatingDock } from "@/components/FloatingDock";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) router.replace("/login");
      else setReady(true);
    });
  }, [router]);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--muted)]">Cargando…</div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <div className="min-h-screen overflow-auto pb-[calc(5.5rem+env(safe-area-inset-bottom))] p-4 sm:p-6">{children}</div>
      <FloatingDock onLogout={logout} />
    </div>
  );
}
