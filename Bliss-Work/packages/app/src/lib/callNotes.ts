/**
 * Shared meeting notes: the model, the merge, and the file they become.
 *
 * ── Why append-only points rather than a shared document ─────────────────────
 * "Write the important points" is a list, and a list of immutable entries is
 * the one collaborative shape that needs no conflict resolution: two people
 * typing at once produce two entries, not a fight over one string. A real
 * shared document would need an ordered log or a CRDT, and a server to hold it.
 *
 * ── Where notes live ─────────────────────────────────────────────────────────
 * In the room, and in this browser. Entries travel between participants over
 * the SFU's data channel (lib/roomMessages), so everyone in the call sees the
 * same list, and each client keeps its own copy in localStorage so a reload
 * mid-call does not lose it. There is NO server copy: nobody who was not in the
 * call can read them, and nothing survives past the people who were there —
 * which is why exporting is a first-class action rather than a nicety.
 */
import { utf8ByteLength } from "./textBytes";
import { loadLocalCopy, meetingArtifactFilename, saveLocalCopy } from "./meetingArtifact";

/** One point, written by one participant. Immutable once made. */
export interface NoteEntry {
  /** Unique across the room. The dedupe key when two clients sync. */
  id: string;
  /** Display name of whoever wrote it, captured at the time. */
  author: string;
  text: string;
  /** Unix ms. Sorting key, so a late-arriving sync interleaves correctly. */
  at: number;
}

/** Longest single point, in UTF-8 BYTES — matching the server's
 *  CallTranscriptTextMax, which is what actually stores it. Long enough for a
 *  real sentence, short enough that a paste of a whole document does not
 *  become one unreadable entry — or a data message that will not fit on the
 *  wire.
 *
 *  Bytes, not characters: see CHAT_TEXT_MAX in lib/callChat for why a
 *  `.length` cap here would silently pass text the server then rejects. */
export const NOTE_TEXT_MAX = 500;

/** How many entries a room keeps. A cap rather than unbounded growth: this
 *  lives in memory and in localStorage, and a meeting that produced five
 *  hundred points has other problems. */
const NOTES_MAX = 500;

export function isNoteEntry(v: unknown): v is NoteEntry {
  if (!v || typeof v !== "object") return false;
  const n = v as Partial<NoteEntry>;
  return (
    typeof n.id === "string" &&
    n.id.length > 0 &&
    n.id.length <= 64 &&
    typeof n.author === "string" &&
    n.author.length <= 120 &&
    typeof n.text === "string" &&
    n.text.length > 0 &&
    utf8ByteLength(n.text) <= NOTE_TEXT_MAX &&
    typeof n.at === "number" &&
    Number.isFinite(n.at)
  );
}

/**
 * Fold incoming entries into the ones we hold.
 *
 * Deduped by id and sorted by time, so it does not matter how many copies of an
 * entry arrive or in what order — which is what makes the sync-on-join cheap:
 * everyone already in the room may answer a newcomer, and the duplicates
 * collapse here instead of being coordinated away on the wire.
 */
export function mergeNotes(held: NoteEntry[], incoming: NoteEntry[]): NoteEntry[] {
  const byId = new Map(held.map((n) => [n.id, n]));
  for (const n of incoming) {
    if (!isNoteEntry(n)) continue;
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  const all = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // Keep the NEWEST when the cap bites: the end of a meeting is the half worth
  // having, and dropping from the front keeps the list stable for everyone.
  return all.length > NOTES_MAX ? all.slice(all.length - NOTES_MAX) : all;
}

/** The exported file: plain text, because it has to be readable by whoever it
 *  is pasted to, in whatever they open it with. */
export function notesToText(title: string, notes: NoteEntry[]): string {
  const when = (t: number) =>
    new Date(t).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const first = notes[0];
  const head = [title || "Meeting notes", first ? when(first.at) : ""].filter(Boolean);
  const lines = notes.map((n) => `- [${when(n.at)}] ${n.author}: ${n.text}`);
  return [...head, "", ...(lines.length ? lines : ["(no notes were taken)"]), ""].join("\n");
}

/** A filename that says which meeting, and sorts. */
export function notesFilename(title: string, at = new Date()): string {
  return meetingArtifactFilename(title, "notes", at);
}

const KEY = (callId: string) => `bliss.notes.${callId}`;

/** This browser's copy, so a reload mid-call does not lose the list. */
export function loadNotes(callId: string): NoteEntry[] {
  return loadLocalCopy(KEY(callId), mergeNotes);
}

export function saveNotes(callId: string, notes: NoteEntry[]): void {
  saveLocalCopy(KEY(callId), notes);
}
