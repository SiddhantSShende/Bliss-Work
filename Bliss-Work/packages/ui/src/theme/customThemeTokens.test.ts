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
