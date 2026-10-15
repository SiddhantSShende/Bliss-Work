/**
 * Custom themes are token sets, not a second component design. These pin the
 * three things that make that true: a Custom theme supplies EVERY property a
 * preset family varies (so no preset value can show through), its neutrals are the
 * presets' own, and theme.css / the components carry no custom-only styling.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOM_NEUTRALS, CUSTOM_THEME_PROPERTIES, customThemeStyle, oklchOf } from "./customThemeTokens";
import { THEMES } from "./themes";

const CSS = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

function tokens(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.@]/g, "\\$&");
  const block = CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const FAMILIES = THEMES.map((t) => t.classes.find((c) => c !== "light" && c !== "dark")).filter((f): f is string => !!f);

describe("a Custom theme covers every token a preset family varies", () => {
  it.each([false, true])("dark=%s", (dark) => {
    const custom = customThemeStyle({ colors: ["#10b981", "#06b6d4", "#a855f7"] }, dark);
    for (const family of FAMILIES) {
      // Anything a family declares that is not a shared neutral in `:root` must be supplied here too.
      const declared = Object.keys(tokens(dark ? `.dark.${family}` : `.${family}`));
      for (const name of declared) expect(Object.keys(custom), `${family}: ${name}`).toContain(name);
    }
  });

  it("lists every property it can set, so a switch can clear them all", () => {
    for (const dark of [false, true]) {
      for (const name of Object.keys(customThemeStyle({ colors: ["#336699"] }, dark))) {
        expect(CUSTOM_THEME_PROPERTIES).toContain(name);
      }
    }
  });
});

describe("Custom neutrals are the presets' neutrals", () => {
  it("light: surface, muted and fg equal the shared set every family but Teal uses", () => {
    // Teal's own light --color-muted is a slate (#64748b), the one family-specific neutral.
    for (const family of FAMILIES.filter((f) => f !== "teal")) {
      const t = tokens(`.${family}`);
      for (const [name, value] of Object.entries(CUSTOM_NEUTRALS.light)) {
        expect(t[name]!.toLowerCase(), `${family} ${name}`).toBe(value);
      }
    }
  });

  it("dark: bg, surface, muted and fg equal the neutral dark presets'", () => {
    const rose = tokens(".dark.rose");
    for (const [name, value] of Object.entries(CUSTOM_NEUTRALS.dark)) {
      expect(rose[name]!.toLowerCase(), name).toBe(value);
    }
  });
});

describe("the colours the person chose are preserved", () => {
  const colors = ["#10b981", "#06b6d4", "#a855f7"];
  it.each([false, true])("accent and gradient stops are exactly the picks (dark=%s)", (dark) => {
    const s = customThemeStyle({ colors }, dark);
    expect(s["--color-accent"]).toBe(colors[0]);
    expect(s["--color-brand-from"]).toBe(colors[0]);
    expect(s["--color-brand-mid"]).toBe(colors[1]);
    expect(s["--color-brand-to"]).toBe(colors[2]);
  });

  it("two colours blend into the middle stop; one colour is a flat fill", () => {
    expect(customThemeStyle({ colors: ["#111111", "#eeeeee"] })["--color-brand-mid"]).toBe(
      "color-mix(in oklab, #111111 50%, #eeeeee)",
    );
    const one = customThemeStyle({ colors: ["#336699"] });
    expect([one["--color-brand-from"], one["--color-brand-to"]]).toEqual(["#336699", "#336699"]);
  });

  it("the charts follow the accent's hue, not a preset's", () => {
    const { hue } = oklchOf("#10b981");
    expect(hue).toBeGreaterThan(150);
    expect(hue).toBeLessThan(175);
    for (const dark of [false, true]) {
      const s = customThemeStyle({ colors: ["#10b981"] }, dark);
      for (const name of ["--color-chart-ink", "--color-heat-0", "--color-heat-5"]) {
        expect(s[name]).toContain(` ${hue.toFixed(1)})`);
      }
    }
  });

  it("a grey accent gets a grey chart ramp", () => {
    expect(customThemeStyle({ colors: ["#808080"] })["--color-heat-5"]).toMatch(/oklch\(0\.52 0(\.0\d*)? /);
  });
});

/** WCAG contrast ratio between two #rrggbb colours — computed independently of
 *  customThemeTokens.ts so a bug in the implementation can't pass its own check. */
function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the primary text colour tracks the 2nd/3rd pick", () => {
  it.each([false, true])("one colour keeps the fixed neutral (dark=%s)", (dark) => {
    const neutral = (dark ? CUSTOM_NEUTRALS.dark : CUSTOM_NEUTRALS.light)["--color-fg"];
    expect(customThemeStyle({ colors: ["#336699"] }, dark)["--color-fg"]).toBe(neutral);
  });

  it.each([false, true])("two colours use the 2nd pick, when it's already readable (dark=%s)", (dark) => {
    // A near-black (light) / near-white (dark) 2nd pick already clears 4.5:1 unadjusted.
    const colors = dark ? ["#2563eb", "#f5f5f5"] : ["#2563eb", "#1a1a1a"];
    expect(customThemeStyle({ colors }, dark)["--color-fg"]).toBe(colors[1]);
  });

  it.each([false, true])("three colours use the 3rd pick, when it's already readable (dark=%s)", (dark) => {
    const colors = dark ? ["#2563eb", "#06b6d4", "#f5f5f5"] : ["#2563eb", "#06b6d4", "#1a1a1a"];
    expect(customThemeStyle({ colors }, dark)["--color-fg"]).toBe(colors[2]);
  });

  it("changing the picks changes the text colour, with no change to the stored colours", () => {
    const theme = { colors: ["#2563eb", "#06b6d4", "#1a1a1a"] };
    const before = customThemeStyle(theme)["--color-fg"];
    const after = customThemeStyle({ colors: ["#2563eb", "#06b6d4", "#2a2a2a"] })["--color-fg"];
    expect(after).not.toBe(before);
    expect(theme.colors).toEqual(["#2563eb", "#06b6d4", "#1a1a1a"]); // input never mutated
  });

  it("a low-contrast pick is nudged, not left unreadable, and the pick itself is untouched by the nudge", () => {
    // Cyan on the light surface/bg is well under 4.5:1 unadjusted.
    const picked = "#67e8f9";
    const style = customThemeStyle({ colors: ["#2563eb", picked] });
    expect(style["--color-fg"]).not.toBe(picked);
    expect(contrastRatio(style["--color-fg"]!, "#fafafa")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(style["--color-fg"]!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("every two-colour pick, however poor its own contrast, ends up at or above 4.5:1", () => {
    const palette = ["#ffee00", "#67e8f9", "#f472b6", "#111111", "#ffffff", "#84cc16", "#001f5c", "#a855f7"];
    for (const dark of [false, true]) {
      const [bg, surface] = dark
        ? [CUSTOM_NEUTRALS.dark["--color-bg"], CUSTOM_NEUTRALS.dark["--color-surface"]]
        : ["#fafafa", CUSTOM_NEUTRALS.light["--color-surface"]];
      for (const a of palette) {
        for (const b of palette) {
          if (a === b) continue;
          const fg = customThemeStyle({ colors: [a, b] }, dark)["--color-fg"]!;
          expect(contrastRatio(fg, bg), `[${a},${b}] dark=${dark} bg`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(fg, surface), `[${a},${b}] dark=${dark} surface`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("the same holds for the 3rd pick of a three-colour theme", () => {
    const thirdPicks = ["#ffee00", "#67e8f9", "#f472b6", "#84cc16"];
    for (const dark of [false, true]) {
      const [bg, surface] = dark
        ? [CUSTOM_NEUTRALS.dark["--color-bg"], CUSTOM_NEUTRALS.dark["--color-surface"]]
        : ["#fafafa", CUSTOM_NEUTRALS.light["--color-surface"]];
      for (const third of thirdPicks) {
        const fg = customThemeStyle({ colors: ["#2563eb", "#a855f7", third] }, dark)["--color-fg"]!;
        expect(contrastRatio(fg, bg), `third=${third} dark=${dark} bg`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(fg, surface), `third=${third} dark=${dark} surface`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("no custom-only styling remains", () => {
  const SRC = new URL("../../..", import.meta.url).pathname; // packages/
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "dist") return [];
      return statSync(path).isDirectory() ? walk(path) : /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });

  it("theme.css has no .custom-theme selector, and no source applies or reads such a class", () => {
    expect(CSS).not.toMatch(/\.custom-theme/);
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\.custom-theme|["']custom-theme["']|nav-icon-tile|CUSTOM_THEME_CLASS/);
    }
  });
});
