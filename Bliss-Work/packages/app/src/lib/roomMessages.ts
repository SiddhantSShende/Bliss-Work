/**
 * What participants say to each other DIRECTLY, over the SFU's data channel.
 *
 * ── Why not the server ───────────────────────────────────────────────────────
 * Three things in the room are true only while the room exists — a raised hand,
 * the notes being taken, and whether recording is running — and all three are
 * needed by everyone in the call within a second of happening. Routing them
 * through messaging-svc would mean a table, an event type and a fan-out for
 * state with no life after the meeting. LiveKit already carries a reliable
 * datagram between exactly the people who hold a room token, which is the same
 * audience and the same lifetime.
 *
 * ── This is UNTRUSTED input ──────────────────────────────────────────────────
 * A data message is written by another participant's client, not by the server,
 * so `decodeRoomMessage` validates every field and returns null rather than
 * throwing or trusting. Nothing here grants anything: the worst a malformed or
 * malicious message can do is fail to be a message.
 */
import { isNoteEntry, type NoteEntry } from "./callNotes";

/** How many notes a sync answer carries. Bounded because a data message has a
 *  size limit on the wire; a newcomer to a long meeting gets the recent tail
 *  rather than a payload that would be dropped. */
export const NOTES_SYNC_MAX = 100;

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
    case "recording":
      return typeof m.on === "boolean" ? { t: "recording", on: m.on } : null;
    default:
      return null;
  }
}
