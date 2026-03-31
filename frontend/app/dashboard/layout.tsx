"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FloatingDashboardNav } from "@/components/FloatingDashboardNav";

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
      <div className="min-h-screen overflow-auto px-4 pb-6 pt-[calc(4.25rem+env(safe-area-inset-top))] sm:px-6 sm:pb-8 sm:pt-[calc(4.5rem+env(safe-area-inset-top))] lg:px-8">
        <div className="page-shell">{children}</div>
      </div>
      <FloatingDashboardNav onLogout={logout} />
    </div>
  );
}
