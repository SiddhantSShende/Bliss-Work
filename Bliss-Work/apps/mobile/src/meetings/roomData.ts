/**
 * In-meeting chat and shared notes: the wire format, validation and merge.
 *
 * Mobile's port of web's lib/roomMessages + lib/callChat + lib/callNotes
 * (packages/app), kept WIRE-COMPATIBLE so a phone and a browser in the same
 * room read each other's messages: JSON over the LiveKit data channel, one
 * discriminated `t` per message, entries deduped by id.
 *
 * Everything arriving here was written by another participant's client, not by
 * the server, so every field is validated and a bad message is dropped rather
 * than trusted (see decodeRoomMessage). Nothing here grants anything.
 */

export interface ChatEntry {
  /** Unique across the room; the dedupe key when two clients sync. */
  id: string;
  /** Sender's room identity (their BlissWork user id). */
  from: string;
  fromName: string;
  /** null = Everyone; otherwise the one identity it was addressed to. */
  to: string | null;
  text: string;
  /** Unix ms; sorting key so a late sync interleaves correctly. */
  at: number;
}

export interface NoteEntry {
  id: string;
  author: string;
  text: string;
  at: number;
}

/** UTF-8 BYTES, matching the server's CallTranscriptTextMax — not characters. */
export const CHAT_TEXT_MAX = 500;
export const NOTE_TEXT_MAX = 500;
export const CHAT_MAX = 500;
export const NOTES_MAX = 500;
export const CHAT_SYNC_MAX = 100;
export const NOTES_SYNC_MAX = 100;

export type RoomMessage =
  | { t: 'hand'; raised: boolean }
  | { t: 'note'; note: NoteEntry }
  | { t: 'notes-request' }
  | { t: 'notes-sync'; notes: NoteEntry[] }
  | { t: 'chat'; msg: ChatEntry }
  | { t: 'chat-request' }
  | { t: 'chat-sync'; msgs: ChatEntry[] }
  | { t: 'recording'; on: boolean };

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Trim to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
export function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8ByteLength(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export function isChatEntry(v: unknown): v is ChatEntry {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<ChatEntry>;
  return (
    typeof c.id === 'string' &&
    c.id.length > 0 &&
    c.id.length <= 64 &&
    typeof c.from === 'string' &&
    c.from.length > 0 &&
    c.from.length <= 64 &&
    typeof c.fromName === 'string' &&
    c.fromName.length <= 120 &&
    (c.to === null || (typeof c.to === 'string' && c.to.length > 0 && c.to.length <= 64)) &&
    typeof c.text === 'string' &&
    c.text.length > 0 &&
    utf8ByteLength(c.text) <= CHAT_TEXT_MAX &&
    typeof c.at === 'number' &&
    Number.isFinite(c.at)
  );
}

export function isNoteEntry(v: unknown): v is NoteEntry {
  if (!v || typeof v !== 'object') return false;
  const n = v as Partial<NoteEntry>;
  return (
    typeof n.id === 'string' &&
    n.id.length > 0 &&
    n.id.length <= 64 &&
    typeof n.author === 'string' &&
    n.author.length <= 120 &&
    typeof n.text === 'string' &&
    n.text.length > 0 &&
    utf8ByteLength(n.text) <= NOTE_TEXT_MAX &&
    typeof n.at === 'number' &&
    Number.isFinite(n.at)
  );
}

export function encodeRoomMessage(m: RoomMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

export function decodeRoomMessage(bytes: Uint8Array): RoomMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  switch (m.t) {
    case 'hand':
      return typeof m.raised === 'boolean' ? { t: 'hand', raised: m.raised } : null;
    case 'note':
      return isNoteEntry(m.note) ? { t: 'note', note: m.note } : null;
    case 'notes-request':
      return { t: 'notes-request' };
    case 'notes-sync':
      // Filtered, not rejected: one bad entry must not cost a newcomer the rest.
      return Array.isArray(m.notes) ? { t: 'notes-sync', notes: m.notes.filter(isNoteEntry).slice(0, NOTES_SYNC_MAX) } : null;
    case 'chat':
      return isChatEntry(m.msg) ? { t: 'chat', msg: m.msg } : null;
    case 'chat-request':
      return { t: 'chat-request' };
    case 'chat-sync':
      return Array.isArray(m.msgs) ? { t: 'chat-sync', msgs: m.msgs.filter(isChatEntry).slice(0, CHAT_SYNC_MAX) } : null;
    case 'recording':
      return typeof m.on === 'boolean' ? { t: 'recording', on: m.on } : null;
    default:
      return null;
  }
}

/** Dedupe by id, sort by time, keep the NEWEST `cap`. Returns `held` itself
 *  (same reference) when nothing new arrived, so React state doesn't churn. */
export function mergeById<T extends { id: string; at: number }>(held: readonly T[], incoming: readonly T[], cap: number): T[] {
  const byId = new Map(held.map((e) => [e.id, e]));
  let changed = false;
  for (const entry of incoming) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    changed = true;
  }
  if (!changed) return held as T[];
  const all = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export const mergeChat = (held: readonly ChatEntry[], incoming: readonly ChatEntry[]) => mergeById(held, incoming.filter(isChatEntry), CHAT_MAX);
export const mergeNotes = (held: readonly NoteEntry[], incoming: readonly NoteEntry[]) => mergeById(held, incoming.filter(isNoteEntry), NOTES_MAX);

/** May we re-send this to `peer` when answering their catch-up request? */
export function visibleToPeer(entry: ChatEntry, peer: string): boolean {
  return entry.to === null || entry.to === peer || entry.from === peer;
}

/** Only what this viewer is party to (a second pass behind the wire). */
export function visibleToMe(entry: ChatEntry, me: string): boolean {
  return entry.to === null || entry.to === me || entry.from === me;
}

/** Messages after the seen-mark that someone else wrote. */
export function unreadSince(chat: readonly ChatEntry[], seenAt: number, me: string): number {
  let n = 0;
  for (const c of chat) {
    if (c.from === me) continue;
    if (c.at > seenAt) n++;
  }
  return n;
}

const rand = () => Math.random().toString(36).slice(2, 8);

export function newChatEntry(a: { from: string; fromName: string; to: string | null; text: string; at?: number; rand?: string }): ChatEntry {
  const at = a.at ?? Date.now();
  return {
    id: `${a.from || 'me'}-${at}-${a.rand ?? rand()}`,
    from: a.from,
    fromName: a.fromName,
    to: a.to,
    text: truncateToUtf8Bytes(a.text, CHAT_TEXT_MAX),
    at,
  };
}

export function newNoteEntry(a: { identity: string; author: string; text: string; at?: number; rand?: string }): NoteEntry {
  const at = a.at ?? Date.now();
  return {
    id: `${a.identity || 'me'}-${at}-${a.rand ?? rand()}`,
    author: a.author,
    text: truncateToUtf8Bytes(a.text, NOTE_TEXT_MAX),
    at,
  };
}
