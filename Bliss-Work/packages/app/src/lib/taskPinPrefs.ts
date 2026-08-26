/**
 * Desktop-only "pinned" marker for assigned tasks, kept on THIS DEVICE.
 *
 * Distinct from the Electron "Pin to desktop" sticky-note feature (see
 * PlatformConfig.pinTask / StickyWidget's `onPin`/`pinned` props), which opens
 * an always-on-top OS window and is authoritative in the main process. This
 * marker is a plain client-side flag — a task the desktop app is showing you
 * gets marked pinned automatically the first time it appears assigned, and
 * clicking Unpin just clears the flag. There is no server concept of this at
 * all, so localStorage (mirroring lib/mailPrefs) is the whole store.
 *
 * `autoPinned` remembers every task id this device has EVER auto-pinned, so
 * that unpinning a task doesn't get silently undone the next time its data
 * refetches — auto-pin only ever fires once per task per device.
 */
import { useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "tb.assigned-task-pin.prefs";

type TaskPinState = Readonly<{
  pinned: readonly string[];
  autoPinned: readonly string[];
}>;

const EMPTY: TaskPinState = { pinned: [], autoPinned: [] };

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function load(): TaskPinState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const { pinned, autoPinned } = parsed as { pinned?: unknown; autoPinned?: unknown };
    return { pinned: readStringArray(pinned), autoPinned: readStringArray(autoPinned) };
  } catch {
    // Unavailable or corrupt — not worth failing a render over.
    return EMPTY;
  }
}

function save(state: TaskPinState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage may be unavailable; the in-memory state still drives this session. */
  }
}

let state: TaskPinState = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): TaskPinState {
  return state;
}

/** Pin a task the first time it's seen assigned; a no-op on every later call. */
export function autoPinAssignedTask(taskId: string): void {
  if (state.autoPinned.includes(taskId)) return;
  state = { pinned: [...state.pinned, taskId], autoPinned: [...state.autoPinned, taskId] };
  save(state);
  listeners.forEach((listener) => listener());
}

/** Remove a task from the pinned view. It will not be auto-pinned again. */
export function unpinAssignedTask(taskId: string): void {
  if (!state.pinned.includes(taskId)) return;
  state = { ...state, pinned: state.pinned.filter((id) => id !== taskId) };
  save(state);
  listeners.forEach((listener) => listener());
}

export function useAssignedTaskPin() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => ({
      isPinned: (taskId: string) => snap.pinned.includes(taskId),
    }),
    [snap],
  );
}
