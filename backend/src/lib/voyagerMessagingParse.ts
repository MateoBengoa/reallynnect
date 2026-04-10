import type { InboxListRow } from "../types/inboxList.js";

export function buildVoyagerPhotoUrl(pic: unknown): string | null {
  if (!pic || typeof pic !== "object") return null;
  const p = pic as Record<string, unknown>;
  const vi =
    (p["com.linkedin.common.VectorImage"] as Record<string, unknown> | undefined) ??
    (typeof p.rootUrl === "string" ? p : null);
  if (!vi) return null;
  const root = typeof vi.rootUrl === "string" ? vi.rootUrl : null;
  const arts = vi.artifacts as Array<Record<string, unknown>> | undefined;
  if (!root || !Array.isArray(arts) || !arts.length) return null;
  const best = [...arts].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
  const seg = best?.fileIdentifyingUrlPathSegment;
  if (typeof seg !== "string" || !seg) return null;
  return root.endsWith("/") ? `${root}${seg}` : `${root}/${seg}`;
}

export function voyagerUrnToThreadId(urn: string): string | null {
  if (!urn) return null;
  const tupleM = urn.match(/,([^,)]+)\)$/);
  if (tupleM?.[1]) {
    try {
      return decodeURIComponent(tupleM[1]);
    } catch {
      return tupleM[1];
    }
  }
  const simpleM = urn.match(/urn:li:(?:thread|msg_thread):(.+)$/);
  if (simpleM?.[1]) return simpleM[1];
  return null;
}

export function parseMiniProfileVoyager(mp: unknown): { name: string | null; photoUrl: string | null } {
  if (!mp || typeof mp !== "object") return { name: null, photoUrl: null };
  const o = mp as Record<string, unknown>;
  const fn = typeof o.firstName === "string" ? o.firstName.trim() : "";
  const ln = typeof o.lastName === "string" ? o.lastName.trim() : "";
  const name = [fn, ln].filter(Boolean).join(" ") || null;
  const photoUrl = buildVoyagerPhotoUrl(o.picture) ?? buildVoyagerPhotoUrl(o.profilePicture);
  return { name, photoUrl };
}

/** LinkedIn a veces devuelve firstName "New" en huecos de UI / participante fantasma. */
export function isPlaceholderVoyagerPeerName(name: string | null | undefined): boolean {
  if (name == null) return true;
  const t = name.trim();
  if (t.length < 2) return true;
  if (/^new$/i.test(t)) return true;
  if (/^linkedin$/i.test(t)) return true;
  return false;
}

export function parseVoyagerConversationList(body: unknown, maxRows: number): InboxListRow[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;

  const candidates: unknown[] = [];
  if (Array.isArray(b.included)) {
    for (const item of b.included) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (String(o.$type ?? "").toLowerCase().includes("conversation") && typeof o.entityUrn === "string") {
        candidates.push(item);
      }
    }
  }
  if (!candidates.length && Array.isArray(b.elements)) {
    for (const item of b.elements) {
      if (item && typeof item === "object") candidates.push(item);
    }
  }
  if (!candidates.length) {
    const data = b.data as Record<string, unknown> | undefined;
    if (data && Array.isArray(data.elements)) {
      for (const item of data.elements) {
        if (item && typeof item === "object") candidates.push(item);
      }
    }
  }

  const includedByUrn = new Map<string, Record<string, unknown>>();
  if (Array.isArray(b.included)) {
    for (const item of b.included) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.entityUrn === "string") includedByUrn.set(o.entityUrn, o);
      if (typeof o.$id === "string") includedByUrn.set(o.$id, o);
    }
  }

  const rows: InboxListRow[] = [];
  for (const conv of candidates) {
    if (rows.length >= maxRows) break;
    const c = conv as Record<string, unknown>;

    const rawUrn = String(c.entityUrn ?? "");
    let conversationId = typeof c.conversationId === "string" ? c.conversationId : voyagerUrnToThreadId(rawUrn);
    if (!conversationId && rawUrn) {
      const m = rawUrn.match(/(2-[A-Za-z0-9+/=_-]+)/);
      if (m?.[1]) conversationId = m[1];
    }
    if (!conversationId) continue;

    const lastActivityAt = Number(c.lastActivityAt ?? c.lastSeenAt ?? 0);
    const lastActivityAtIso = lastActivityAt > 0 ? new Date(lastActivityAt).toISOString() : null;

    let peerName: string | null = null;
    let peerPhotoUrl: string | null = null;
    const participantsRaw = c.participants;
    const participantsList: unknown[] = Array.isArray(participantsRaw)
      ? participantsRaw
      : Array.isArray((participantsRaw as Record<string, unknown> | undefined)?.elements)
        ? ((participantsRaw as Record<string, unknown>).elements as unknown[])
        : [];
    const parsedParticipants: { name: string | null; photoUrl: string | null }[] = [];
    for (const p of participantsList) {
      if (!p || typeof p !== "object") continue;
      const pm = p as Record<string, unknown>;
      let mp: unknown = pm.miniProfile;
      if (!mp && typeof pm.entityUrn === "string") {
        const res = includedByUrn.get(pm.entityUrn);
        if (res) mp = res.miniProfile ?? res;
      }
      if (!mp && typeof pm.firstName === "string") mp = pm;
      parsedParticipants.push(parseMiniProfileVoyager(mp));
    }
    const viable = parsedParticipants.filter((x) => !isPlaceholderVoyagerPeerName(x.name));
    const chosen = viable.find((x) => x.photoUrl) ?? viable[0];
    if (chosen) {
      peerName = chosen.name;
      peerPhotoUrl = chosen.photoUrl;
    } else if (parsedParticipants.length > 0) {
      const nonNew = parsedParticipants.filter((x) => x.name && !/^new$/i.test(x.name.trim()));
      const fallback = nonNew[0] ?? parsedParticipants[0];
      peerName = fallback?.name && !/^new$/i.test(fallback.name.trim()) ? fallback.name : null;
      peerPhotoUrl = fallback?.photoUrl ?? null;
    }

    let preview = "—";
    const eventsRaw = c.events ?? c.messages;
    const eventsList: unknown[] = Array.isArray(eventsRaw)
      ? eventsRaw
      : Array.isArray((eventsRaw as Record<string, unknown> | undefined)?.elements)
        ? ((eventsRaw as Record<string, unknown>).elements as unknown[])
        : [];
    const lastEvent = eventsList.length ? eventsList[eventsList.length - 1] : null;
    if (lastEvent && typeof lastEvent === "object") {
      const ev = lastEvent as Record<string, unknown>;
      const content = ev.eventContent ?? ev.messageBody;
      if (content && typeof content === "object") {
        const bd = (content as Record<string, unknown>).attributedBody ?? (content as Record<string, unknown>).body;
        if (bd && typeof bd === "object") {
          const text = String((bd as Record<string, unknown>).text ?? "").trim();
          if (text) preview = text.slice(0, 300);
        }
      }
      if (preview === "—" && typeof ev.body === "string") preview = ev.body.slice(0, 300);
    }

    if (/^new$/i.test((peerName ?? "").trim())) {
      continue;
    }

    rows.push({ conversationId, peerName, preview, peerPhotoUrl, lastActivityAtIso });
  }
  return rows;
}
