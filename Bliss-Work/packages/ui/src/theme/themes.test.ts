import { describe, expect, it } from "vitest";
import { THEMES, isThemeId, themeClasses, themeName, darkCounterpart, defaultThemeFor, ALL_THEME_CLASSES } from "./themes";

describe("THEMES", () => {
  it("offers exactly the five light families, in the required order, and nothing else", () => {
    expect(THEMES.map((t) => t.id)).toEqual(["default", "rose", "blue", "purple", "teal"]);
  });

  it("never offers a dark id directly — only reachable via the toggle", () => {
    for (const t of THEMES) expect(t.id.endsWith("-dark")).toBe(false);
  });

  it("gives Blue no extra class — it's the app's original, unmodified palette", () => {
    expect(THEMES.find((t) => t.id === "blue")!.classes).toEqual(["light"]);
  });

  it("gives every other family its own class alongside the light/dark axis", () => {
    expect(THEMES.find((t) => t.id === "default")!.classes).toEqual(["light", "default"]);
    expect(THEMES.find((t) => t.id === "rose")!.classes).toEqual(["light", "rose"]);
    expect(THEMES.find((t) => t.id === "purple")!.classes).toEqual(["light", "purple"]);
    expect(THEMES.find((t) => t.id === "teal")!.classes).toEqual(["light", "teal"]);
  });
});

describe("isThemeId", () => {
  it("accepts every current light and dark id", () => {
    for (const id of [
      "default", "default-dark", "blue", "blue-dark", "rose", "rose-dark", "purple", "purple-dark", "teal", "teal-dark",
    ]) {
      expect(isThemeId(id)).toBe(true);
    }
  });

  it("rejects removed/old ids — the pre-rewrite theme system had these", () => {
    // "graphite-lime"/"graphite-lime-dark" were the old Graphite+Lime toggle's
    // ids; "lime"/"lime-dark" were its later reincarnation as a proper fifth
    // family — removed again so Settings → Theme offers exactly the five
    // families above. "orange"/"green" never existed as real theme ids.
    for (const id of [
      "light", "dark", "graphite-lime", "graphite-lime-dark", "lime", "lime-dark", "orange", "green",
    ]) {
      expect(isThemeId(id)).toBe(false);
    }
  });
});

describe("darkCounterpart", () => {
  it("maps every light family to its own dark id, never a generic default", () => {
    expect(darkCounterpart("default")).toBe("default-dark");
    expect(darkCounterpart("rose")).toBe("rose-dark");
    expect(darkCounterpart("blue")).toBe("blue-dark");
    expect(darkCounterpart("purple")).toBe("purple-dark");
    expect(darkCounterpart("teal")).toBe("teal-dark");
  });

  it("is its own inverse — toggling dark off returns exactly the family toggled from", () => {
    for (const light of ["default", "rose", "blue", "purple", "teal"] as const) {
      const dark = darkCounterpart(light);
      expect(darkCounterpart(dark)).toBe(light);
    }
  });
});

describe("defaultThemeFor", () => {
  it("resolves to the Default family — the default for anyone with no saved preference — in the requested mode", () => {
    expect(defaultThemeFor(false)).toBe("default");
    expect(defaultThemeFor(true)).toBe("default-dark");
  });
});

describe("themeClasses / themeName", () => {
  it("round-trip every id to its own classes and a non-empty name", () => {
    for (const id of [
      "default", "default-dark", "blue", "blue-dark", "rose", "rose-dark", "purple", "purple-dark", "teal", "teal-dark",
    ] as const) {
      expect(themeClasses(id).length).toBeGreaterThan(0);
      expect(themeName(id).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the Default theme for an invalid id rather than throwing", () => {
    // @ts-expect-error deliberately invalid input, mirroring a corrupted localStorage value
    expect(themeClasses("not-a-real-theme")).toEqual(themeClasses("default"));
  });
});

describe("ALL_THEME_CLASSES", () => {
  it("lists every class any theme can apply — light, dark, and each family", () => {
    expect(new Set(ALL_THEME_CLASSES)).toEqual(new Set(["light", "dark", "default", "rose", "purple", "teal"]));
  });

  it("does not include the removed lime family", () => {
    expect(ALL_THEME_CLASSES).not.toContain("lime");
  });
});
