/**
 * The decision half of the incoming-call slider, kept free of React Native so
 * it can be unit-tested: given how far the thumb has been dragged, has the user
 * committed to answering, declining, or not yet?
 */
export type SlideDecision = 'answer' | 'decline' | null;

/** Fraction of the half-track (centre -> end) the thumb must travel to commit. */
export const SLIDE_COMMIT_RATIO = 0.72;

/** `dx` is the thumb's offset from centre (right positive); `range` is the
 *  distance from centre to either end. */
export function slideDecision(dx: number, range: number): SlideDecision {
  if (range <= 0) return null;
  const ratio = dx / range;
  if (ratio >= SLIDE_COMMIT_RATIO) return 'answer';
  if (ratio <= -SLIDE_COMMIT_RATIO) return 'decline';
  return null;
}

/** Clamp a drag offset to the track. */
export function clampSlide(dx: number, range: number): number {
  return Math.max(-range, Math.min(range, dx));
}
