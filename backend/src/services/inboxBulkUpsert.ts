import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboxListRow } from "../types/inboxList.js";

function inboxEnvInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Volcado masivo con orden de lista LinkedIn (list_rank 0 = más reciente arriba). */
export async function bulkUpsertInboxConversationsOrdered(
  sb: SupabaseClient,
  accountId: string,
  rows: InboxListRow[],
  syncBaseTime: number
): Promise<void> {
  if (!rows.length) return;
  const n = rows.length;
  const chunk = inboxEnvInt("INBOX_BULK_UPSERT_CHUNK", 480);
  const parallel = Math.min(4, Math.max(1, inboxEnvInt("INBOX_BULK_UPSERT_PARALLEL", 2)));

  const upsertSlice = async (off: number, slice: InboxListRow[]): Promise<void> => {
    if (!slice.length) return;
    const payload = slice.map((r, j) => {
      const i = off + j;
      const preview = (r.preview ?? "—").trim().slice(0, 500) || "—";
      return {
        account_id: accountId,
        conversation_id: r.conversationId,
        peer_name: r.peerName ?? null,
        peer_photo_url: r.peerPhotoUrl ?? null,
        list_preview: preview,
        list_rank: i,
        list_last_activity_at: r.lastActivityAtIso ?? null,
        updated_at: new Date(syncBaseTime + (n - i) * 2000).toISOString(),
      };
    });
    const { error } = await sb.from("inbox_conversations").upsert(payload, { onConflict: "account_id,conversation_id" });
    if (error) console.error("[inbox_sync] bulk upsert inbox_conversations:", error.message);
  };

  for (let off = 0; off < rows.length; off += chunk * parallel) {
    const batch: Promise<void>[] = [];
    for (let p = 0; p < parallel; p++) {
      const start = off + p * chunk;
      if (start >= rows.length) break;
      batch.push(upsertSlice(start, rows.slice(start, start + chunk)));
    }
    await Promise.all(batch);
  }
  console.log(`[inbox_sync] bulk lista ordenada: ${rows.length} conversaciones`);
}
