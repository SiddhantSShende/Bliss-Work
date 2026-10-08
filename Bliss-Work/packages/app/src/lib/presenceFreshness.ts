/**
 * Which presence answers are still newer than a live event?
 *
 * The 20s poll (usePresence) is reconciliation, and a request is in flight for
 * a while — long enough for a `presence.online/offline` event to land in the
 * shared cache and then be overwritten by an answer that was computed BEFORE it
 * happened: a dot flipping back to the wrong colour for up to a full interval.
 * The bridge notes every live presence event here; the poll asks which of its
 * ids may still be written.
 *
 * Per user, not one global stamp: in a busy org some event lands every few
 * seconds, and a global "an event happened since this poll started" would
 * discard nearly every poll and starve the reconciliation it exists for.
 */
const lastEventAt = new Map<string, number>();
let snapshotAt = 0;

/** A live online/offline event for one user was just applied to the cache. */
export function noteLivePresence(userId: string, at = Date.now()): void {
  lastEventAt.set(userId, at);
}

/** A live snapshot replaced the whole set — it supersedes every older answer. */
export function noteLiveSnapshot(at = Date.now()): void {
  snapshotAt = at;
}

/** The ids whose poll answer (the request began at `startedAt`) is not older
 *  than something live the cache already reflects. */
export function idsFreshSince(ids: readonly string[], startedAt: number): string[] {
  if (snapshotAt >= startedAt) return [];
  return ids.filter((id) => (lastEventAt.get(id) ?? -Infinity) < startedAt);
}
