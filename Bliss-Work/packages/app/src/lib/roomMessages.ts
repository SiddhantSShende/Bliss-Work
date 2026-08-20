/**
 * What participants say to each other DIRECTLY, over the SFU's data channel.
 *
 * ── Why not the server ───────────────────────────────────────────────────────
 * Four things in the room are true only while the room exists — a raised hand,
 * the notes being taken, the chat, and whether recording is running — and all
 * of them are needed by everyone in the call within a second of happening.
 * Routing them through messaging-svc would mean a table, an event type and a
 * fan-out for state with no life after the meeting. LiveKit already carries a
 * reliable datagram between exactly the people who hold a room token, which is
 * the same audience and the same lifetime.
 *
 * Chat additionally gets something the server path could not give it for free:
 * a message addressed to ONE participant is handed to LiveKit with a
 * destination list, so the SFU never delivers the bytes to anybody else. A
 * private message is private on the wire, not by a rule someone's client is
 * trusted to follow.
 *
 * ── This is UNTRUSTED input ──────────────────────────────────────────────────
 * A data message is written by another participant's client, not by the server,
 * so `decodeRoomMessage` validates every field and returns null rather than
 * throwing or trusting. Nothing here grants anything: the worst a malformed or
 * malicious message can do is fail to be a message.
 */
import { isNoteEntry, type NoteEntry } from "./callNotes";
import { isChatEntry, type ChatEntry } from "./callChat";

/** How many notes a sync answer carries. Bounded because a data message has a
 *  size limit on the wire; a newcomer to a long meeting gets the recent tail
 *  rather than a payload that would be dropped. */
export const NOTES_SYNC_MAX = 100;

/** The same bound for a chat catch-up, for the same reason. */
export const CHAT_SYNC_MAX = 100;

export type RoomMessage =
  /** Hand up or down. Also re-sent when someone new arrives, so a late joiner
   *  sees the hands that were already up. */
  | { t: "hand"; raised: boolean }
  /** One new point, the moment it is written. */
  | { t: "note"; note: NoteEntry }
  /** "I just arrived — what have I missed?" */
  | { t: "notes-request" }
  /** The answer. Everyone present may send one; duplicates collapse on merge. */
  | { t: "notes-sync"; notes: NoteEntry[] }
  /**
   * One chat message.
   *
   * Sent to everyone when `msg.to` is null, and to a single destination
   * identity when it is not — see the note on privacy above. The addressing is
   * carried in the entry as well as on the wire so the recipient can render
   * "private" without inferring it.
   */
  | { t: "chat"; msg: ChatEntry }
  /** "I just arrived — what has been said?" */
  | { t: "chat-request" }
  /** The answer, filtered to what the asker is party to (see visibleToPeer). */
  | { t: "chat-sync"; msgs: ChatEntry[] }
  /** Recording started or stopped, so the notice appears without waiting for a
   *  refetch. The SERVER remains the source of truth on join. */
  | { t: "recording"; on: boolean };

/** `Uint8Array<ArrayBuffer>`, not the wider `Uint8Array<ArrayBufferLike>`:
 *  livekit-client's publishData refuses a view that might be backed by a
 *  SharedArrayBuffer, which TextEncoder's return type does not rule out. */
export function encodeRoomMessage(m: RoomMessage): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(m)) as Uint8Array<ArrayBuffer>;
}

export function decodeRoomMessage(bytes: Uint8Array): RoomMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  switch (m.t) {
    case "hand":
      return typeof m.raised === "boolean" ? { t: "hand", raised: m.raised } : null;
    case "note":
      return isNoteEntry(m.note) ? { t: "note", note: m.note } : null;
    case "notes-request":
      return { t: "notes-request" };
    case "notes-sync": {
      if (!Array.isArray(m.notes)) return null;
      // Filtered rather than rejected: one bad entry in a sync must not cost a
      // newcomer the other ninety-nine.
      const notes = m.notes.filter(isNoteEntry).slice(0, NOTES_SYNC_MAX);
      return { t: "notes-sync", notes };
    }
    case "chat":
      return isChatEntry(m.msg) ? { t: "chat", msg: m.msg } : null;
    case "chat-request":
      return { t: "chat-request" };
    case "chat-sync": {
      if (!Array.isArray(m.msgs)) return null;
      // Filtered, not rejected — same reason as notes-sync above.
      const msgs = m.msgs.filter(isChatEntry).slice(0, CHAT_SYNC_MAX);
      return { t: "chat-sync", msgs };
    }
    case "recording":
      return typeof m.on === "boolean" ? { t: "recording", on: m.on } : null;
    default:
      return null;
  }
}
