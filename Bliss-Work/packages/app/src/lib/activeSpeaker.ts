/**
 * Who belongs on the stage, when nobody has pinned anyone.
 *
 * ── Why this is not just "whoever LiveKit says is speaking" ───────────────────
 * The SFU reports speaking as a boolean that flickers: a cough, a keyboard, an
 * "mm-hm" while someone else holds the floor. Promoting on every one of those
 * turns the main tile into a strobe, and the person actually presenting keeps
 * vanishing mid-sentence. So the raw signal is filtered by TIME on both edges:
 *
 *   PROMOTE_AFTER_MS  a newcomer must hold the floor this long before taking it
 *   DEMOTE_AFTER_MS   the current speaker keeps it through pauses this long
 *
 * The asymmetry is the point. Taking the stage is made deliberately harder than
 * keeping it, so a short interjection is heard without being seen, and drawing
 * breath mid-sentence does not cost the presenter their tile.
 *
 * ── Why the stage never empties ──────────────────────────────────────────────
 * When everyone stops talking the last speaker STAYS. A room where the main
 * tile blanks out every time a sentence ends is worse than one that lags: the
 * viewer loses the person they were listening to, and the layout jumps. The
 * stage is only released when that participant actually leaves.
 *
 * Pure and time-injected — no timers, no LiveKit types, no React. The caller
 * passes `now`, which is what makes every rule here testable.
 */

/** How long a new voice must hold the floor before it takes the stage. */
export const PROMOTE_AFTER_MS = 500;

/** How long the current speaker may pause without losing the stage. */
export const DEMOTE_AFTER_MS = 2_000;

/**
 * What the filter remembers between samples.
 *
 * `startedAt` holds the moment each identity's CURRENT run of speech began, and
 * is deleted the moment they stop — so a run is always contiguous and a
 * stop/start cannot accumulate credit towards promotion.
 */
export interface SpeakerState {
  /** Who is on the stage, or null before anyone has spoken. */
  active: string | null;
  /** identity → when their current speaking run began. */
  startedAt: Record<string, number>;
  /** When the active speaker last fell silent; null while they are speaking. */
  silentSince: number | null;
}

export const initialSpeakerState: SpeakerState = {
  active: null,
  startedAt: {},
  silentSince: null,
};

/**
 * Fold one sample of "who is speaking right now" into the filter.
 *
 * @param prev     the previous state
 * @param speaking every identity the SFU currently reports as speaking
 * @param now      caller's clock, so tests do not need timers
 */
export function reduceActiveSpeaker(
  prev: SpeakerState,
  speaking: readonly string[],
  now: number,
): SpeakerState {
  const live = new Set(speaking);

  // Start a run for anyone newly speaking; end it for anyone who stopped. A run
  // that ends is forgotten entirely — see the note on `startedAt`.
  const startedAt: Record<string, number> = {};
  for (const id of live) {
    startedAt[id] = prev.startedAt[id] ?? now;
  }

  const activeIsSpeaking = prev.active !== null && live.has(prev.active);
  const silentSince = activeIsSpeaking ? null : (prev.silentSince ?? now);

  // The floor is held: nothing else can take it while its holder is talking.
  if (activeIsSpeaking) {
    return { active: prev.active, startedAt, silentSince: null };
  }

  // The longest-running qualifying voice that is not already on stage. Longest
  // rather than first so that when two people start together the one who has
  // actually been going longer wins, instead of whichever the SFU listed first.
  let challenger: string | null = null;
  let challengerSince = Infinity;
  for (const id of live) {
    if (id === prev.active) continue;
    const since = startedAt[id]!;
    if (now - since < PROMOTE_AFTER_MS) continue;
    if (since < challengerSince) {
      challenger = id;
      challengerSince = since;
    }
  }

  if (challenger === null) {
    return { active: prev.active, startedAt, silentSince };
  }

  // Nobody holds the stage yet — the first qualifying voice simply takes it.
  if (prev.active === null) {
    return { active: challenger, startedAt, silentSince: null };
  }

  // Someone does hold it, and is quiet. They keep it until the pause is long
  // enough to be a handover rather than a breath.
  if (now - silentSince! < DEMOTE_AFTER_MS) {
    return { active: prev.active, startedAt, silentSince };
  }

  return { active: challenger, startedAt, silentSince: null };
}

/**
 * Drop anyone who has left the room.
 *
 * The one thing that clears the stage: a tile that is not there cannot be shown,
 * and leaving it set would render an empty stage while the rest of the room
 * stays squeezed into a strip beside it.
 *
 * Returns the SAME object when nothing changed, so callers can use it as a
 * render guard.
 */
export function pruneSpeakers(prev: SpeakerState, present: ReadonlySet<string>): SpeakerState {
  const activeGone = prev.active !== null && !present.has(prev.active);
  const staleRuns = Object.keys(prev.startedAt).filter((id) => !present.has(id));
  if (!activeGone && staleRuns.length === 0) return prev;

  const startedAt = { ...prev.startedAt };
  for (const id of staleRuns) delete startedAt[id];
  return {
    active: activeGone ? null : prev.active,
    startedAt,
    silentSince: activeGone ? null : prev.silentSince,
  };
}
