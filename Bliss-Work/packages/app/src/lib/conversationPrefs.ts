/**
 * Per-conversation preferences that live on THIS DEVICE.
 *
 * Mute and "add shortcut" are both answers to "how should this chat behave for
 * ME", and neither has anywhere on the server to live: messaging-svc has no
 * per-conversation preference, and auth-svc has no `user_settings` table — the
 * same gap Settings.tsx records against its notification toggle. Rather than
 * offer two menu rows that cannot be honoured, the preference is kept where the
 * app already keeps device-local state (localStorage, as MiniMeeting and
 * BrowserStickies do) and read back by the chat and channel lists.
 *
 * The consequence is stated plainly in the UI: these are per-device, and they
 * do not follow the user to another browser or to the desktop app. When a
 * `user_settings` endpoint exists, `load`/`save` are the only two functions
 * that have to change.
 *
 * Reactivity is a subscription rather than a query because there is no server
 * round-trip to model: the menu toggles a value and the list beside it has to
 * redraw in the same tick.
 */
import { useMemo, useSyncExternalStore } from "react";

/** Which list a conversation id belongs to. Ids are UUIDs from two different
 *  tables, so they are namespaced rather than pooled. */
export type ConversationScope = "chat" | "channel";

/** The preferences a conversation can carry. */
export type ConversationPref = "muted" | "shortcut";

const STORAGE_KEY = "tb.conversation.prefs";

type PrefState = Readonly<Record<ConversationPref, readonly string[]>>;

const EMPTY: PrefState = { muted: [], shortcut: [] };

/** `scope:id` — see ConversationScope. */
function keyOf(scope: ConversationScope, id: string): string {
  return `${scope}:${id}`;
}

function load(): PrefState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const o = parsed as Record<string, unknown>;
    return { muted: strings(o.muted), shortcut: strings(o.shortcut) };
  } catch {
    // Unavailable (some Electron contexts) or corrupt — a preference is not
    // worth failing a render over, so fall back to "nothing is set".
    return EMPTY;
  }
}

function strings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function save(state: PrefState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage may be unavailable; the in-memory state still drives this session. */
  }
}

// One snapshot object, replaced only when something actually changes, so
// useSyncExternalStore's identity check does not loop.
let state: PrefState = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function snapshot(): PrefState {
  return state;
}

/** Add or remove one conversation from one preference list. */
export function toggleConversationPref(
  pref: ConversationPref,
  scope: ConversationScope,
  id: string,
): void {
  const key = keyOf(scope, id);
  const held = state[pref];
  const next = held.includes(key) ? held.filter((k) => k !== key) : [...held, key];
  state = { ...state, [pref]: next };
  save(state);
  listeners.forEach((fn) => fn());
}

/** Test seam: drop everything, in memory and on disk. */
export function resetConversationPrefs(): void {
  state = EMPTY;
  save(state);
  listeners.forEach((fn) => fn());
}

/**
 * The preferences, as predicates.
 *
 * Returned memoized against the snapshot so a list that renders one row per
 * conversation does not rebuild its callbacks on every unrelated render.
 */
export function useConversationPrefs() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => ({
      isMuted: (scope: ConversationScope, id: string) => snap.muted.includes(keyOf(scope, id)),
      hasShortcut: (scope: ConversationScope, id: string) =>
        snap.shortcut.includes(keyOf(scope, id)),
    }),
    [snap],
  );
}
