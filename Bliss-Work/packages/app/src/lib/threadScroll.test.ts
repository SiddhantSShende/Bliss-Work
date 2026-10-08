import { describe, expect, it } from "vitest";
import { isIdSwapOnly, isNearBottom, NEAR_BOTTOM_PX } from "./threadScroll";

describe("isNearBottom", () => {
  const el = (scrollTop: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop });
  it("is true at the bottom and within the slack", () => {
    expect(isNearBottom(el(600))).toBe(true);
    expect(isNearBottom(el(600 - NEAR_BOTTOM_PX))).toBe(true);
  });
  it("is false once scrolled further up", () => {
    expect(isNearBottom(el(600 - NEAR_BOTTOM_PX - 1))).toBe(false);
  });
});

describe("isIdSwapOnly", () => {
  const prev = { firstId: "a", lastId: "temp:1", count: 3 };
  it("detects a temp row becoming its real row", () => {
    expect(isIdSwapOnly(prev, { firstId: "a", lastId: "m9", count: 3 })).toBe(true);
  });
  it("is not a swap when a row was added as well", () => {
    expect(isIdSwapOnly(prev, { firstId: "a", lastId: "m9", count: 4 })).toBe(false);
  });
  it("is not a swap when the last row was not a temp row", () => {
    expect(isIdSwapOnly({ ...prev, lastId: "m1" }, { firstId: "a", lastId: "m9", count: 3 })).toBe(false);
  });
  it("is not a swap when the last id did not change", () => {
    expect(isIdSwapOnly(prev, prev)).toBe(false);
  });
});
