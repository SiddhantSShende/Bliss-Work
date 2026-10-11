import { describe, expect, it } from "vitest";
import { isCustomColors, isCustomTheme, readableForeground } from "./customTheme";
import { customThemeStyle } from "./customThemeTokens";

const WHITE = "#ffffff";
const DARK = "#000000";

describe("readableForeground", () => {
  it.each([
    ["#ffee00", DARK], // yellow — white text on it is ~1.2:1
    ["#84cc16", DARK], // lime
    ["#ffffff", DARK],
    ["#22d3ee", DARK], // bright cyan
    ["#001f5c", WHITE], // navy
    ["#6366f1", DARK], // the editor's default indigo — white is 4.47:1, black 4.70:1
    ["#e11d48", WHITE], // rose
    ["#000000", WHITE],
  ])("%s → %s", (background, expected) => {
    expect(readableForeground(background)).toBe(expected);
  });

  it("gives at least 4.5:1 contrast for every colour it is asked about", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // A coarse sweep of the RGB cube, including the awkward mid-tones.
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const bg = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
          const [hi, lo] = [luminance(bg), luminance(readableForeground(bg))].sort((a, b) => b - a);
          expect((hi! + 0.05) / (lo! + 0.05), bg).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

/** WCAG contrast ratio between two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the Complete button's text on a custom accent", () => {
  it.each([
    ["yellow (light)", "#ffee00"],
    ["amber", "#f59e0b"],
    ["lime", "#a3e635"],
    ["white", "#ffffff"],
    ["indigo", "#4f46e5"],
    ["dark indigo", "#312e81"],
    ["navy", "#001f5c"],
    ["black", "#000000"],
  ])("%s (%s) stays at or above 4.5:1 with the foreground the theme picks", (_name, accent) => {
    const fg = customThemeStyle({ colors: [accent] })["--color-accent-fg"]!;
    expect(contrastRatio(accent, fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("would have been unreadable with the old fixed white on yellow", () => {
    expect(contrastRatio("#ffee00", "#ffffff")).toBeLessThan(1.5);
  });
});

describe("the custom hover shade (--color-accent-strong)", () => {
  /** What `color-mix(in srgb, <c> 88%, white|black)` yields: a plain per-channel blend. */
  const mix = (hex: string, target: number) =>
    "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.88 + target * 0.12).toString(16).padStart(2, "0")).join("");
  const strong = (accent: string) => customThemeStyle({ colors: [accent] })["--color-accent-strong"]!;

  it("is a real shade, not the accent itself (the old value gave no hover feedback)", () => {
    for (const accent of ["#ffee00", "#4f46e5", "#001f5c", "#6366f1"]) expect(strong(accent)).not.toBe(accent);
  });

  it("moves away from the text colour: lighter under black text, darker under white", () => {
    expect(strong("#ffee00")).toBe("color-mix(in srgb, #ffee00 88%, white)");
    expect(strong("#4f46e5")).toBe("color-mix(in srgb, #4f46e5 88%, black)");
  });

  it("can only RAISE the text's contrast on hover, for any colour", () => {
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
      const accent = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      const fg = readableForeground(accent);
      const hover = mix(accent, fg === "#000000" ? 255 : 0);
      expect(contrastRatio(hover, fg), accent).toBeGreaterThanOrEqual(contrastRatio(accent, fg) - 1e-9);
    }
  });
});

describe("customThemeStyle", () => {
  it("derives the accent foreground from the first colour instead of fixing it to white", () => {
    expect(customThemeStyle({ colors: ["#ffee00"] })["--color-accent-fg"]).toBe(DARK);
    expect(customThemeStyle({ colors: ["#001f5c", "#ffee00"] })["--color-accent-fg"]).toBe(WHITE);
  });
});

describe("isCustomTheme", () => {
  it("needs no name", () => {
    expect(isCustomTheme({ colors: ["#6366f1"] })).toBe(true);
  });

  it("still accepts an entry saved with the old `name` field", () => {
    expect(isCustomTheme({ name: "Sunset", colors: ["#ff8800", "#aa2200"] })).toBe(true);
  });

  it.each([
    null,
    "x",
    {},
    { colors: [] },
    { colors: ["#111111", "#222222", "#333333", "#444444"] },
    { colors: ["red"] },
    { colors: ["#12345"] },
    { colors: [1] },
  ])("rejects %j", (value) => {
    expect(isCustomTheme(value)).toBe(false);
    expect(isCustomColors((value as { colors?: unknown } | null)?.colors)).toBe(false);
  });
});
