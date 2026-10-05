/**
 * How to lay N equal participant tiles out in a W×H area.
 *
 * ── Why this is computed rather than left to a CSS grid ──────────────────────
 * The grid used to pick its column count from the VIEWPORT (`sm:3 xl:4`) and
 * stretch each row to fill the height. Two people on a desktop window were two
 * 320px-wide, 800px-tall slivers holding a 16:9 picture, with the right half of
 * the area empty. The right column count depends on the shape of the AREA the
 * tiles get — which shrinks when the chat panel opens, and has nothing to do
 * with the viewport — and on how many tiles there are. That is arithmetic, so
 * it is done here, once, and the tiles are given the exact size it returns.
 */

export interface Area {
  width: number;
  height: number;
}

export interface TileFit {
  cols: number;
  rows: number;
  /** Every tile is exactly this size, in whole pixels. */
  width: number;
  height: number;
}

/**
 * The shape of a tile: 16:9 — what cameras produce — in a landscape area, 4:3 in
 * a portrait one (a phone, or a window narrowed by the chat panel).
 *
 * Deliberately NOT searched for. A 16:9 picture is no bigger in a squarer tile,
 * it just sits in a larger box, so choosing the shape that "fills the area best"
 * picks squares for two people on a wide window and letterboxes every camera.
 * The one thing the shape must not do is stay 16:9 in a tall area, where the
 * tiles would be short strips with most of the height left over.
 */
function tileAspect(area: Area): number {
  return area.height > area.width ? 4 / 3 : 16 / 9;
}

/** Fewer, wider rows are preferred when they cost no more than this fraction of
 *  the biggest possible tile: two people belong side by side on a wide window
 *  even though stacking them would make each a few percent larger. */
const COLUMN_BIAS = 0.92;

/** The smallest tile a page of the grid may shrink to before the grid holds
 *  fewer people per page instead. Below this a face stops being recognisable. */
export const MIN_TILE_WIDTH = 160;

/** The largest tiles of exactly `aspect` that fit `count` of them in `area`. */
function fitAspect(count: number, area: Area, gap: number, aspect: number): TileFit | null {
  const candidates: TileFit[] = [];
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (area.width - gap * (cols - 1)) / cols;
    const cellH = (area.height - gap * (rows - 1)) / rows;
    // Whole pixels, rounded DOWN: rounding up could make a row a fraction of a
    // pixel wider than the area and wrap its last tile onto a new row.
    const width = Math.floor(Math.min(cellW, cellH * aspect));
    if (width > 0) candidates.push({ cols, rows, width, height: Math.floor(width / aspect) });
  }
  if (candidates.length === 0) return null;
  const widest = Math.max(...candidates.map((c) => c.width));
  // Within the tolerance of the biggest, take the one with the most columns.
  return candidates
    .filter((c) => c.width >= widest * COLUMN_BIAS)
    .reduce((a, b) => (b.cols > a.cols ? b : a));
}

/**
 * The layout of `count` tiles that uses `area` best, or null when there is
 * nothing to lay out (no tiles, or an area with no room in it).
 */
export function fitTiles(count: number, area: Area, gap: number): TileFit | null {
  if (count < 1 || area.width <= 0 || area.height <= 0) return null;
  return fitAspect(count, area, gap, tileAspect(area));
}

/**
 * How many people one page of the grid should hold: as many as `max`, fewer
 * when that many would make tiles smaller than MIN_TILE_WIDTH. Never below one.
 */
export function membersPerPage(area: Area, gap: number, max: number): number {
  for (let n = max; n > 1; n--) {
    const fit = fitTiles(n, area, gap);
    if (fit && fit.width >= MIN_TILE_WIDTH) return n;
  }
  return 1;
}
