import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const unpinned = new Set<string>();
let requestedTaskId: string | null = null;
let snapshot = { unpinnedIds: [] as string[], requestedTaskId: null as string | null };

function notify() {
  snapshot = {
    unpinnedIds: Array.from(unpinned),
    requestedTaskId,
  };
  for (const listener of listeners) listener();
}

export function pinBrowserTask(taskId: string) {
  unpinned.delete(taskId);
  requestedTaskId = taskId;
  notify();
}

export function unpinBrowserTask(taskId: string) {
  unpinned.add(taskId);
  if (requestedTaskId === taskId) requestedTaskId = null;
  notify();
}

export function useBrowserTaskPinState() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => ({ unpinnedIds: [], requestedTaskId: null }),
  );
}

export function consumeBrowserTaskSelection() {
  const taskId = snapshot.requestedTaskId;
  requestedTaskId = null;
  snapshot = { ...snapshot, requestedTaskId: null };
  return taskId;
}
