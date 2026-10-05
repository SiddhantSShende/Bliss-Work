/**
 * The one place that decides how task cards are laid out on the Tasks screen.
 *
 * Every task listing there (Allocated to me, Completed, Left, Ignored, Missed and
 * the allocator's My Tasks) renders its cards into TASK_CARD_GRID and splits each
 * card with the BODY / MAIN / SIDE classes, so they share one width and one set of
 * proportions instead of each submodule carrying its own numbers.
 *
 * The split is a CONTAINER query on the card (`@container/card`), not a viewport
 * breakpoint: what matters is how wide the card actually is, and that already
 * follows the sidebar, the column count and browser zoom.
 *
 *   >= 34rem  landscape: MAIN (title, description, times) | SIDE (people, actions)
 *   <  34rem  stacked, one column, same content in the same order
 *
 * The grid's 34rem floor means a card is never narrower than that unless the
 * screen itself is, so a wide content area gets one full-width landscape card per
 * row (or two on a very wide one) rather than a strip of narrow, tall ones.
 */

/** Cards flow into as many 34rem+ columns as fit; `min(100%, ...)` stops a phone overflowing. */
export const TASK_CARD_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,34rem),1fr))] gap-3";

/** Makes the card the container the BODY / SIDE queries below measure. */
export const TASK_CARD_ROOT = "@container/card";

/** The card's body: one column when narrow, MAIN beside SIDE once the card is wide. */
export const TASK_CARD_BODY =
  "grid min-w-0 gap-x-4 gap-y-2.5 @min-[34rem]/card:grid-cols-[minmax(0,1fr)_minmax(17rem,40%)]";

/** Title, description and times. */
export const TASK_CARD_MAIN = "flex min-w-0 flex-col gap-2.5";

/** People and actions; set off from MAIN by a divider once they sit beside it. */
export const TASK_CARD_SIDE =
  "flex min-w-0 flex-col gap-2.5 @min-[34rem]/card:border-l @min-[34rem]/card:border-border/50 @min-[34rem]/card:pl-4";

/** A block at the top of SIDE: divided from what is above it when stacked, flush when beside MAIN. */
export const TASK_CARD_SIDE_FIRST =
  "border-t border-border/50 pt-2.5 @min-[34rem]/card:border-t-0 @min-[34rem]/card:pt-0";

/**
 * Allocated to me: no people block, so SIDE holds only the action row. A fixed, narrow
 * column (not the 16-24rem one) keeps the buttons from floating in empty space and
 * gives the width back to the description; SIDE_SLIM centres them on the card's height.
 * The fixed width also matters: the action row is its own size container, so it would
 * measure 0 in an auto-sized column.
 */
export const TASK_CARD_BODY_SLIM =
  "grid min-w-0 gap-x-4 gap-y-2.5 @min-[38rem]/card:grid-cols-[minmax(0,1fr)_14rem]";

export const TASK_CARD_SIDE_SLIM =
  "flex min-w-0 flex-col gap-2.5 @min-[38rem]/card:justify-center @min-[38rem]/card:border-l @min-[38rem]/card:border-border/50 @min-[38rem]/card:pl-4";
