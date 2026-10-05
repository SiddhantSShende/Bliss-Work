import { describe, expect, it } from "vitest";
import { fitTiles, membersPerPage, MIN_TILE_WIDTH } from "./tileLayout";

const GAP = 8;

/** The bounding box of the whole arrangement — it must never leave the area. */
function extent(fit: NonNullable<ReturnType<typeof fitTiles>>) {
  return {
    width: fit.cols * fit.width + GAP * (fit.cols - 1),
    height: fit.rows * fit.height + GAP * (fit.rows - 1),
  };
}

describe("fitTiles", () => {
  it("has nothing to lay out without tiles or without room", () => {
    expect(fitTiles(0, { width: 800, height: 600 }, GAP)).toBeNull();
    expect(fitTiles(3, { width: 0, height: 600 }, GAP)).toBeNull();
    expect(fitTiles(3, { width: 800, height: -1 }, GAP)).toBeNull();
  });

  it("gives one tile the whole width of a landscape area, at 16:9", () => {
    const fit = fitTiles(1, { width: 1312, height: 800 }, GAP)!;
    expect(fit).toMatchObject({ cols: 1, rows: 1, width: 1312, height: 738 });
  });

  it("puts two people side by side on a wide window, not stacked", () => {
    const fit = fitTiles(2, { width: 1312, height: 800 }, GAP)!;
    expect(fit.cols).toBe(2);
    expect(fit.width).toBe(652);
    // The regression this exists for: two 320×800 slivers holding a 16:9 picture.
    expect(fit.height).toBeLessThan(fit.width);
  });

  it("stacks two people, and squares the tiles up, in a tall narrow area", () => {
    const fit = fitTiles(2, { width: 350, height: 600 }, GAP)!;
    expect(fit.cols).toBe(1);
    expect(fit.rows).toBe(2);
    // 16:9 would leave 200px of the height unused; 4:3 fills it.
    expect(fit.width / fit.height).toBeCloseTo(4 / 3, 1);
  });

  it("lays four out as a 2×2 on a wide window", () => {
    const fit = fitTiles(4, { width: 1312, height: 800 }, GAP)!;
    expect([fit.cols, fit.rows]).toEqual([2, 2]);
  });

  it("never lets the arrangement leave the area, for any count or area", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
      for (const [width, height] of [
        [1792, 1009], [1312, 800], [976, 800], [592, 668], [350, 426], [190, 378], [640, 924], [2400, 300],
      ] as const) {
        const fit = fitTiles(count, { width, height }, GAP);
        if (!fit) continue;
        const box = extent(fit);
        expect(box.width, `${count} in ${width}x${height}`).toBeLessThanOrEqual(width);
        expect(box.height, `${count} in ${width}x${height}`).toBeLessThanOrEqual(height);
        expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(count);
      }
    }
  });
});

describe("membersPerPage", () => {
  it("keeps the full page where the tiles stay readable", () => {
    expect(membersPerPage({ width: 1312, height: 800 }, GAP, 12)).toBe(12);
  });

  it("holds fewer per page when the area is too small for that many faces", () => {
    const n = membersPerPage({ width: 350, height: 480 }, GAP, 12);
    expect(n).toBeLessThan(12);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(fitTiles(n, { width: 350, height: 480 }, GAP)!.width).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
  });

  it("never drops below one, however small the area", () => {
    expect(membersPerPage({ width: 90, height: 50 }, GAP, 12)).toBe(1);
  });
});
