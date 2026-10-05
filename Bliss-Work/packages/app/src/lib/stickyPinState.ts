import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { EventType, type StickyPinChanged } from "@taskboard/shared";
import { pinBrowserTask } from "./browserStickyState";
import { useRuntime } from "./runtime";
import { qk } from "./queryKeys";

/**
 * The signed-in user's pin choice per task, as sticky-svc holds it — the shared,
 * durable state that Web and Desktop both render from. An id missing from the map
 * has no explicit choice recorded (it is pinned by default).
 *
 * The React Query cache is only a copy of the server's answer: it is replaced on
 * every read, patched by the realtime `sticky.pin.changed` event, and rolled back
 * when a write fails. Nothing here is persisted, and nothing in it can outvote a
 * fresh server read.
 */
export type PinState = "PINNED" | "UNPINNED";
export type PinStateMap = Readonly<Record<string, PinState>>;

/** The map after one task changes state. Pure, so the event handler and the
 *  optimistic write share it. */
export function withPinState(prev: PinStateMap | null | undefined, taskId: string, state: PinState): PinStateMap {
  return { ...(prev ?? {}), [taskId]: state };
}

/** True only when the server says the user UNPINNED this task. A task the server
 *  never mentioned, or an unavailable read (`null`), is not unpinned. */
export function isUnpinned(map: PinStateMap | null | undefined, taskId: string): boolean {
  return map?.[taskId] === "UNPINNED";
}

/**
 * Read the pin states. `data` is `null` when sticky-svc is not configured for
 * this build, so callers can tell "not deployed" from "nothing unpinned".
 */
export function useStickyPinStates(enabled: boolean) {
  const { api } = useRuntime();
  return useQuery<PinStateMap | null>({
    queryKey: qk.stickyPinStates,
    queryFn: async () => {
      const read = await api.stickyPinStates();
      if (!read) return null;
      const map: Record<string, PinState> = {};
      for (const id of read.pinned) map[id] = "PINNED";
      for (const id of read.unpinned) map[id] = "UNPINNED";
      return map;
    },
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

/**
 * The map with one task put back to what it was before an optimistic write
 * (`undefined` = it had no entry). Touches that task only: a failed write must
 * never undo a DIFFERENT task's change that landed in the meantime, which
 * restoring a whole-map snapshot would.
 */
export function restorePinState(
  prev: PinStateMap | null | undefined,
  taskId: string,
  prior: PinState | undefined,
): PinStateMap {
  const next = { ...(prev ?? {}) };
  if (prior === undefined) delete next[taskId];
  else next[taskId] = prior;
  return next;
}

/**
 * Write the user's choice to sticky-svc, optimistically, and roll back if it
 * fails. Resolves to the server's answer, or rejects with it (409 once the task
 * has finished, 404 if it is not theirs) — the caller decides what to tell the
 * user. Rolls back THIS task only (see restorePinState).
 */
export function useSetStickyPin() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return async (taskId: string, pinned: boolean) => {
    await qc.cancelQueries({ queryKey: qk.stickyPinStates });
    const prior = qc.getQueryData<PinStateMap | null>(qk.stickyPinStates)?.[taskId];
    const want: PinState = pinned ? "PINNED" : "UNPINNED";
    qc.setQueryData<PinStateMap | null>(qk.stickyPinStates, (prev) => withPinState(prev, taskId, want));
    try {
      return await (pinned ? api.stickyPin(taskId) : api.stickyUnpin(taskId));
    } catch (err) {
      qc.setQueryData<PinStateMap | null>(qk.stickyPinStates, (prev) => restorePinState(prev, taskId, prior));
      throw err;
    }
  };
}

/**
 * The user pinned or unpinned a task — on this device or another. sticky-svc
 * delivers `sticky.pin.changed` to every device they own, which is what keeps
 * Web and Desktop on one pin state.
 *
 * Patches the cached pin states in place (so a card flips without a round trip)
 * and refetches the sticky list. A PINNED change on the web also lifts this
 * session's local "hide" for that task and brings its note to the front: the user
 * just asked for it, so the X they clicked earlier no longer applies. UNPINNED
 * needs nothing more — the note's visibility is derived from the state patched
 * here. Another user's event is ignored (the gateway never sends one, but the
 * check is what makes that a guarantee on this side too).
 */
export function applyStickyPinChanged(
  e: StickyPinChanged,
  ctx: {
    qc: QueryClient;
    invalidate: (key: readonly unknown[]) => void;
    me: string | undefined;
    /** True in Electron, where the OS note windows replace the browser overlay. */
    hasDesktopBridge: boolean;
  },
): void {
  if (e.type !== EventType.StickyPinChanged || e.assigneeId !== ctx.me) return;
  if (ctx.qc.getQueryData(qk.stickyPinStates) !== undefined) {
    ctx.qc.setQueryData<PinStateMap | null>(qk.stickyPinStates, (prev) =>
      withPinState(prev, e.taskId, e.pinState),
    );
  } else {
    ctx.invalidate(qk.stickyPinStates);
  }
  ctx.invalidate(qk.sticky);
  if (e.pinState === "PINNED" && !ctx.hasDesktopBridge) pinBrowserTask(e.taskId);
}
