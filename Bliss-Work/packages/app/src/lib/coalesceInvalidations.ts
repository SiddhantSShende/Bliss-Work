import type { QueryKey } from "@tanstack/react-query";

/**
 * Collapses a burst of cache invalidations into one refetch per key.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * The WebSocket bridge patches caches optimistically and then invalidates the
 * queries it could not patch exactly. That is correct, but it is per EVENT: a
 * message arriving invalidates the conversation list, and so does every read
 * receipt for it. On a busy workspace those arrive in bursts, and each one used
 * to cost a full refetch of the same endpoint — the list was refetched five
 * times to end up in the state the fifth event described.
 *
 * Coalescing over a short window makes a burst cost one request instead of N,
 * and the last event in the burst is still the one the refetch reflects.
 *
 * ── Why a delay is safe here ────────────────────────────────────────────────
 * These invalidations are RECONCILIATION, not the mechanism the UI depends on.
 * The event handlers already patch the visible state synchronously (see
 * `inboxPatch`), so the user sees their own action immediately either way; this
 * only decides how soon the server's version is fetched to confirm it. A quarter
 * of a second is below the threshold anyone notices, and well under the round
 * trip it replaces.
 */
export const INVALIDATE_WINDOW_MS = 250;

/** The only thing this needs from a QueryClient. Declared narrowly rather than
 *  as Pick<QueryClient, …> so the dependency is exactly one method — a real
 *  QueryClient satisfies it, and a test does not have to reproduce the generic
 *  overload just to count calls. */
export interface InvalidationTarget {
  invalidateQueries(filters: { queryKey: QueryKey }): unknown;
}

export interface CoalescedInvalidator {
  /** Queue `key` for invalidation. Repeats within the window collapse. */
  (key: QueryKey): void;
  /** Invalidate everything queued right now. Exposed for tests and for a
   *  caller that genuinely cannot wait (nothing does today). */
  flush(): void;
  /** Drop anything queued without invalidating — for unmount, so a torn-down
   *  bridge cannot fire a refetch into a cache nobody is reading. */
  cancel(): void;
}

export function createCoalescedInvalidator(
  qc: InvalidationTarget,
  windowMs: number = INVALIDATE_WINDOW_MS,
): CoalescedInvalidator {
  // Keyed by the serialized key so two structurally equal keys collapse; the
  // value keeps the original so the invalidation gets a real QueryKey.
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const keys = [...pending.values()];
    pending.clear();
    for (const key of keys) void qc.invalidateQueries({ queryKey: key });
  };

  const invalidate = ((key: QueryKey) => {
    pending.set(JSON.stringify(key), key);
    // Leading event starts the window; the rest ride it. NOT re-armed per
    // event — a steady stream of messages would then never flush at all.
    if (timer === null) timer = setTimeout(flush, windowMs);
  }) as CoalescedInvalidator;

  invalidate.flush = flush;
  invalidate.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };

  return invalidate;
}
