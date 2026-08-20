/**
 * In-meeting chat: the model, the merge, the privacy rule, and the file it
 * becomes.
 *
 * ── Where chat lives ─────────────────────────────────────────────────────────
 * In the room, and in this browser — exactly like lib/callNotes, and for the
 * same reasons. Messages travel between participants over the SFU's data
 * channel (lib/roomMessages), so everyone sees them within a frame of being
 * sent, and each client keeps its own copy so a reload mid-meeting does not
 * lose the thread. There is NO server copy: nobody who was not in the call can
 * read it, and nothing outlives the people who were there. That is why
 * downloading is a first-class action rather than a nicety.
 *
 * ── How "private" is actually private ────────────────────────────────────────
 * A direct message is addressed on the WIRE, not filtered on arrival:
 * `sendData(msg, [recipient])` hands LiveKit a destination list and the SFU
 * delivers to nobody else. A third participant never receives the bytes, so
 * there is no client-side rule for them to disobey. `visibleToPeer` exists for
 * the one case where we re-send what we already hold — the catch-up a newcomer
 * asks for — and it is the same rule stated for that path.
 *
 * ── This is UNTRUSTED input ──────────────────────────────────────────────────
 * Every entry arriving from the wire is written by another participant's
 * client. `isChatEntry` checks every field, and the rendered body is always a
 * text node — never markup. See lib/roomMessages.
 */

/** One message, from one participant. Immutable once sent. */
export interface ChatEntry {
  /** Unique across the room. The dedupe key when two clients sync. */
  id: string;
  /** Sender's room identity — which IS their BlissWork user id. */
  from: string;
  /** Sender's display name, captured when it was sent. */
  fromName: string;
  /**
   * Who it was addressed to.
   *
   * `null` means Everyone. Otherwise it is one participant's identity, and the
   * message was only ever transmitted to them.
   */
  to: string | null;
  text: string;
  /** Unix ms. Sorting key, so a late-arriving sync interleaves correctly. */
  at: number;
}

/** Longest single message. Matches a note: long enough to say something, short
 *  enough that a pasted document does not become one unreadable line — or a
 *  datagram too big for the wire. */
export const CHAT_TEXT_MAX = 500;

/** How many messages a room keeps in memory and in this browser's copy. */
export const CHAT_MAX = 500;

export function isChatEntry(v: unknown): v is ChatEntry {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<ChatEntry>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    c.id.length <= 64 &&
    typeof c.from === "string" &&
    c.from.length > 0 &&
    c.from.length <= 64 &&
    typeof c.fromName === "string" &&
    c.fromName.length <= 120 &&
    (c.to === null || (typeof c.to === "string" && c.to.length > 0 && c.to.length <= 64)) &&
    typeof c.text === "string" &&
    c.text.length > 0 &&
    c.text.length <= CHAT_TEXT_MAX &&
    typeof c.at === "number" &&
    Number.isFinite(c.at)
  );
}

/**
 * Fold incoming messages into the ones we hold.
 *
 * Deduped by id and sorted by time, so it does not matter how many copies
 * arrive or in what order. That is what makes both the catch-up and RECONNECT
 * safe: a client that drops and rejoins is re-sent the thread and the
 * duplicates collapse here rather than appearing twice in the panel.
 */
export function mergeChat(held: ChatEntry[], incoming: readonly ChatEntry[]): ChatEntry[] {
  const byId = new Map(held.map((c) => [c.id, c]));
  let changed = false;
  for (const c of incoming) {
    if (!isChatEntry(c)) continue;
    if (byId.has(c.id)) continue;
    byId.set(c.id, c);
    changed = true;
  }
  // Same list, same object — so a sync that told us nothing new cannot cause a
  // re-render, or scroll a panel somebody is reading.
  if (!changed) return held;
  const all = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // Keep the NEWEST when the cap bites, as the notes do.
  return all.length > CHAT_MAX ? all.slice(all.length - CHAT_MAX) : all;
}

/**
 * May this message be re-sent to `peer`, given that WE hold it?
 *
 * Used only when answering a newcomer's catch-up request. Everything addressed
 * to Everyone, plus the direct messages between us and that person — which they
 * already hold anyway, so the dedupe collapses them. A private exchange with
 * anybody ELSE is not ours to forward, and this is the rule that says so.
 */
export function visibleToPeer(entry: ChatEntry, peer: string): boolean {
  return entry.to === null || entry.to === peer || entry.from === peer;
}

/** Only what this viewer is party to. A defensive second pass: the wire already
 *  guarantees it, and a bug in either layer alone should not leak. */
export function visibleToMe(entry: ChatEntry, me: string): boolean {
  return entry.to === null || entry.to === me || entry.from === me;
}

/** Messages the viewer has not seen yet — everything after the mark. */
export function unreadSince(chat: readonly ChatEntry[], seenAt: number, me: string): number {
  let n = 0;
  for (const c of chat) {
    // Your own message is not news to you.
    if (c.from === me) continue;
    if (c.at > seenAt) n++;
  }
  return n;
}

/** Build one message. The id is unique without coordination: whose client wrote
 *  it, when, and a little randomness for two sent inside the same millisecond. */
export function newChatEntry(args: {
  from: string;
  fromName: string;
  to: string | null;
  text: string;
  at?: number;
  rand?: string;
}): ChatEntry {
  const at = args.at ?? Date.now();
  const rand = args.rand ?? Math.random().toString(36).slice(2, 8);
  return {
    id: `${args.from || "me"}-${at}-${rand}`,
    from: args.from,
    fromName: args.fromName,
    to: args.to,
    text: args.text.slice(0, CHAT_TEXT_MAX),
    at,
  };
}

/**
 * The exported file: plain text, readable wherever it is pasted.
 *
 * Direct messages are marked, because a transcript that renders a private aside
 * as though it were said to the room misrepresents what happened in it.
 */
export function chatToText(
  title: string,
  chat: readonly ChatEntry[],
  nameOf: (identity: string) => string,
): string {
  const when = (t: number) =>
    new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const first = chat[0];
  const head = [title ? `${title} — chat` : "Meeting chat", first ? when(first.at) : ""].filter(
    Boolean,
  );
  const lines = chat.map((c) => {
    const to = c.to === null ? "" : ` (private to ${nameOf(c.to)})`;
    return `- [${when(c.at)}] ${c.fromName}${to}: ${c.text}`;
  });
  return [...head, "", ...(lines.length ? lines : ["(no messages were sent)"]), ""].join("\n");
}

/** A filename that says which meeting, and sorts. */
export function chatFilename(title: string, at = new Date()): string {
  const slug =
    (title || "meeting")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "meeting";
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
  return `${slug}-chat-${day}.txt`;
}

const KEY = (callId: string) => `bliss.chat.${callId}`;

/** This browser's copy, so a reload mid-meeting does not lose the thread.
 *  Storage can be absent (private mode, a locked-down WebView) — that degrades
 *  to "chat lives only in this tab", never to a crash. */
export function loadChat(callId: string): ChatEntry[] {
  try {
    const raw = localStorage.getItem(KEY(callId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeChat([], parsed as ChatEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveChat(callId: string, chat: readonly ChatEntry[]): void {
  try {
    localStorage.setItem(KEY(callId), JSON.stringify(chat));
  } catch {
    // Quota, or no storage at all. The thread is still in memory and still on
    // the wire; losing the cache is not worth interrupting a meeting for.
  }
}
