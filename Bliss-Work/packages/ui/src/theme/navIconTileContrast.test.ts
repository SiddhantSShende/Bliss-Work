/**
 * Secondary-nav icon tiles under a custom theme (`.custom-theme .nav-icon-tile` in
 * theme.css): a dark shade of the accent behind a light shade of it. The shades are
 * `color-mix(in srgb, accent N%, black|white)`, so the ratios are read from the CSS and
 * re-computed here for any accent — a changed percentage that drops the icon below
 * WCAG's 3:1 floor for graphics fails this file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const RULE = CSS.match(/\.custom-theme \.nav-icon-tile\s*\{([^}]*)\}/)?.[1] ?? "";

/** The accent's share (0–1) and the colour it is mixed with, for one declaration. */
function mixOf(property: string): { share: number; with: "black" | "white" } {
  const m = RULE.match(new RegExp(`(?<![-\\w])${property}:\\s*color-mix\\(in srgb,\\s*var\\(--color-accent\\)\\s+(\\d+)%,\\s*(black|white)\\)`));
  if (!m) throw new Error(`nav-icon-tile ${property} is not a color-mix of --color-accent`);
  return { share: Number(m[1]) / 100, with: m[2] as "black" | "white" };
}

function mix(accent: number[], { share, with: other }: ReturnType<typeof mixOf>): number[] {
  const target = other === "white" ? 255 : 0;
  return accent.map((c) => c * share + target * (1 - share));
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Every channel combination on a coarse grid covers black, white, the primaries, yellow, etc.
const STEPS = [0, 64, 128, 192, 255];
const ACCENTS = STEPS.flatMap((r) => STEPS.flatMap((g) => STEPS.map((b) => [r, g, b])));

describe("custom-theme nav icon tile", () => {
  it("is dark fill + light icon, both mixed from --color-accent", () => {
    expect(mixOf("background-color").with).toBe("black");
    expect(mixOf("color").with).toBe("white");
  });

  it("keeps the icon at ≥ 4.5:1 on the tile for any accent", () => {
    const bg = mixOf("background-color");
    const fg = mixOf("color");
    const worst = Math.min(...ACCENTS.map((a) => contrast(mix(a, fg), mix(a, bg))));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});
