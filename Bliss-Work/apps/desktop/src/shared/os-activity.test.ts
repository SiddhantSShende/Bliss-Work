import { describe, expect, it } from "vitest";
import { hasOsActivityTracking } from "./os-activity";

describe("hasOsActivityTracking", () => {
  it("is true only where the main-process tracker runs (Windows)", () => {
    expect(hasOsActivityTracking("win32")).toBe(true);
    expect(hasOsActivityTracking("darwin")).toBe(false);
    expect(hasOsActivityTracking("linux")).toBe(false);
  });
});
