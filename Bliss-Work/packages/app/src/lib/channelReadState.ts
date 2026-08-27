/**
 * Per-channel "last viewed" timestamp, device-local.
 *
 * DMs carry a real, server-computed `conversation.unread` count (see
 * ConversationDTO) — messaging-svc tracks a per-user read cursor for those.
 * `ChannelDTO` (the row shape `GET /channels` returns) carries no such field:
 * a channel's "seen" state has never been part of that response. Rather than
 * add a schema migration and a store/query change for a client's Unread
 * filter tab, this uses the same device-local trade-off conversationPrefs.ts
 * already makes for mute/pin — it does not follow the user to another
 * browser or the desktop app, and it is stated as such wherever it's read.
 */
import { useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "tb.channel.read.v1";

type ReadState = Readonly<Record<string, string>>;

const EMPTY: ReadState = {};

function load(): ReadState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const out: Record<string, string> = {};
    for (const [id, viewedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof viewedAt === "string") out[id] = viewedAt;
    }
    return out;
  } catch {
    // Unavailable (some Electron contexts) or corrupt — falls back to "every
    // channel with a message counts as unread", which is the safe default.
    return EMPTY;
  }
}

function save(state: ReadState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage may be unavailable; the in-memory state still drives this session. */
  }
}

let state: ReadState = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): ReadState {
  return state;
}

/** Record that this channel's messages have been seen, as of right now. */
export function markChannelViewed(channelId: string): void {
  state = { ...state, [channelId]: new Date().toISOString() };
  save(state);
  listeners.forEach((fn) => fn());
}

/** Test seam: drop every recorded "last viewed" mark. */
export function resetChannelReadState(): void {
  state = EMPTY;
  save(state);
  listeners.forEach((fn) => fn());
}

export function useChannelReadState() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => ({
      /** A channel with activity this device has not recorded viewing since. */
      isUnread: (channelId: string, lastMessageAt: string | null): boolean => {
        if (!lastMessageAt) return false;
        const viewedAt = snap[channelId];
        return !viewedAt || new Date(lastMessageAt).getTime() > new Date(viewedAt).getTime();
      },
    }),
    [snap],
  );
}
