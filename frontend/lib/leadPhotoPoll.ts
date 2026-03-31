import { getValidAccessToken } from "@/lib/supabase";

const INTERVAL_MS = 2500;
const MAX_TICKS = 90;
const MAX_CONSECUTIVE_ERRORS = 3;

export type LeadPhotoCheck = {
  photo_url: string | null | undefined;
  profile_url?: string | null;
};

export function leadNeedsProfilePhoto(lead: LeadPhotoCheck): boolean {
  if (lead.photo_url) return false;
  const u = String(lead.profile_url ?? "").toLowerCase();
  return u.includes("linkedin.com") && u.includes("/in/");
}

/**
 * Tras encolar batch-sync-photos, refresca la lista hasta que no queden fotos pendientes
 * o se supere el tiempo máximo (worker lento / fallos).
 *
 * Usa setTimeout encadenado (no setInterval) para evitar ticks concurrentes cuando
 * la red es lenta o falla. Si hay 3 errores consecutivos, se detiene automáticamente.
 */
export function startLeadPhotoPoll(refresh: () => Promise<LeadPhotoCheck[]>): () => void {
  let ticks = 0;
  let consecutiveErrors = 0;
  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const stop = () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    timerId = setTimeout(() => void tick(), INTERVAL_MS);
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    ticks++;
    try {
      if (!(await getValidAccessToken())) {
        stop();
        return;
      }
      const list = await refresh();
      consecutiveErrors = 0;
      const pending = list.some(leadNeedsProfilePhoto);
      if (!pending || ticks >= MAX_TICKS) {
        stop();
        return;
      }
      scheduleNext();
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || ticks >= MAX_TICKS) {
        stop();
        return;
      }
      scheduleNext();
    } finally {
      running = false;
    }
  };

  void tick();
  return stop;
}
