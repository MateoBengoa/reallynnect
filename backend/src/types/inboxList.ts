/** Fila de lista de conversaciones (DOM o Voyager). */
export type InboxListRow = {
  conversationId: string;
  peerName: string | null;
  preview: string;
  peerPhotoUrl: string | null;
  /** ISO 8601: último mensaje según LinkedIn */
  lastActivityAtIso?: string | null;
};
