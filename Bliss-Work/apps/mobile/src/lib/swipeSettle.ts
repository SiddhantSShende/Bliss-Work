/** Width of the revealed Delete action when a row is left partly open. */
export const SWIPE_OPEN_WIDTH = 80;

/** What a row does when the finger lifts. */
export type SwipeSettle = 'delete' | 'open' | 'close';

/** A drag shorter than this is a tap, not a swipe. */
const TAP_SLOP = 6;
/** From the open position, dragging back this far (right) closes the row. */
const CLOSE_DRAG = 20;
/** From closed, the row must be pulled at least this far to stay open. */
const OPEN_COMMIT = SWIPE_OPEN_WIDTH / 2;

/**
 * Where a swiped row ends up. `startOffset` is where the row rested when the
 * gesture began (0 closed, -SWIPE_OPEN_WIDTH open), `dx` how far the finger
 * moved, `width` the row's width. Only a pull past half the row deletes; a small
 * or accidental swipe always settles back closed, and a tap on an open row closes it.
 */
export function swipeSettle(startOffset: number, dx: number, width: number): SwipeSettle {
  const final = Math.min(0, startOffset + dx);
  if (final < -0.5 * width) return 'delete';
  if (startOffset !== 0) {
    if (Math.abs(dx) < TAP_SLOP) return 'close';
    return dx > CLOSE_DRAG ? 'close' : 'open';
  }
  return final < -OPEN_COMMIT ? 'open' : 'close';
}
