/**
 * Favourite (starred) mail, kept on THIS DEVICE.
 *
 * Favorites is the one folder in the mailbox with no column behind it:
 * messaging-svc stores delivery, read state and the caller's own visibility for
 * a mail, and nothing else — there is no per-reader flag to write a star into,
 * and no endpoint that would accept one. Rather than offer a folder that cannot
 * be filled, the mark is kept where this app already keeps device-local state:
 * localStorage, exactly as lib/conversationPrefs keeps mute and shortcut.
 *
 * The consequence is real and worth stating: a star does not follow the reader
 * to another browser or to the desktop app. When messaging-svc grows a
 * per-reader flag, `load`/`save` and `toggleMailFavorite` are the only three
 * things that have to change — every screen reads this through `useMailPrefs`.
 *
 * Reactivity is a subscription rather than a query because there is no server
 * round-trip to model: the row toggles a star and the list it is in has to
 * redraw in the same tick.
 */
import { useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "tb.mail.prefs";

/** Mail ids (`InboxItemDTO.refId` for a MAIL row) the reader has starred. */
type MailPrefState = Readonly<{ favorites: readonly string[] }>;

const EMPTY: MailPrefState = { favorites: [] };

function load(): MailPrefState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const favorites = (parsed as { favorites?: unknown }).favorites;
    return {
      favorites: Array.isArray(favorites)
        ? favorites.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    // Unavailable (some Electron contexts) or corrupt — a star is not worth
    // failing a render over, so fall back to "nothing is starred".
    return EMPTY;
  }
}

function save(state: MailPrefState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage may be unavailable; the in-memory state still drives this session. */
  }
}

// One snapshot object, replaced only when something actually changes, so
// useSyncExternalStore's identity check does not loop.
let state: MailPrefState = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): MailPrefState {
  return state;
}

/** Star an unstarred mail, or unstar a starred one. */
export function toggleMailFavorite(mailId: string): void {
  const favorites = state.favorites.includes(mailId)
    ? state.favorites.filter((id) => id !== mailId)
    : [...state.favorites, mailId];
  state = { favorites };
  save(state);
  listeners.forEach((listener) => listener());
}

/**
 * The stars, as a predicate.
 *
 * Returned memoized against the snapshot so a list that renders one row per
 * mail does not rebuild its callbacks on every unrelated render.
 */
export function useMailPrefs() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => ({
      isFavorite: (mailId: string) => snap.favorites.includes(mailId),
    }),
    [snap],
  );
}
