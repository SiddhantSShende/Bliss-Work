/**
 * A reactive, localStorage-backed singleton store.
 *
 * Factors out the boilerplate behind taskPinPrefs.ts, mailPrefs.ts and
 * conversationPrefs.ts, which each independently reimplemented the same
 * load/save/subscribe/snapshot useSyncExternalStore singleton — one JSON blob
 * in localStorage, reactive across the whole app in one tick, degrading to
 * "lives only in this tab" when storage is unavailable (private mode, a
 * locked-down Electron context) rather than failing a render over it.
 *
 * Callers still own their own state SHAPE, mutators, and the
 * predicate-returning hook that reads it — this only factors out the
 * mechanical parts every one of them needed regardless of what they store.
 */
import { useSyncExternalStore } from "react";

export interface LocalStore<T> {
  /** Current in-memory state (already loaded from storage). */
  get(): T;
  /** Replace the state, persist it, and notify every subscriber. */
  set(next: T): void;
  /** For useSyncExternalStore, if a caller wants to drive its own hook. */
  subscribe(listener: () => void): () => void;
  /** React hook: the live, reactive snapshot. */
  useSnapshot(): T;
}

/**
 * @param key storage key.
 * @param empty the fallback state — used when storage is empty, unavailable,
 *   or holds something `parse` cannot make sense of.
 * @param parse validates + sanitizes whatever JSON.parse returned into `T`.
 *   Called with the parsed value (object, array, primitive, whatever was
 *   actually stored) — a malformed or hand-edited entry must degrade to
 *   `empty`, never throw or resurrect itself past this check.
 */
export function createLocalStore<T>(
  key: string,
  empty: T,
  parse: (raw: unknown) => T,
): LocalStore<T> {
  function load(): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return empty;
      return parse(JSON.parse(raw));
    } catch {
      return empty;
    }
  }

  function save(next: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Storage may be unavailable; the in-memory state still drives this session. */
    }
  }

  // One snapshot object, replaced only when something actually changes, so
  // useSyncExternalStore's identity check does not loop.
  let state: T = load();
  const listeners = new Set<() => void>();

  // Another tab's write to this key fires a `storage` event HERE — the DOM
  // spec never fires it in the tab that made the write. Without this, a tab
  // that has been open since before another tab's last write keeps computing
  // its next state from a stale in-memory snapshot (every mutator here reads
  // via `get()` then calls `set()`), and its own next `set()` silently
  // clobbers whatever the other tab just persisted.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== key) return;
      state = load();
      listeners.forEach((listener) => listener());
    });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function snapshot(): T {
    return state;
  }

  return {
    get: () => state,
    set(next: T) {
      state = next;
      save(state);
      listeners.forEach((listener) => listener());
    },
    subscribe,
    useSnapshot: () => useSyncExternalStore(subscribe, snapshot, snapshot),
  };
}
