/**
 * Readability of the accent-filled buttons — Complete, Acknowledge, the primary
 * Button and every other `bg-accent text-accent-fg` surface — in every preset and
 * in Light and Dark, read straight from theme.css so a changed token cannot slip
 * through unmeasured.
 *
 * ONE RULE for every theme: `--color-accent-fg` is `readableForeground(accent)` —
 * black or white by luminance, whichever contrasts more. Custom themes have always
 * computed it at runtime (customTheme.ts); the presets are static CSS, so their
 * values are written out by hand and THIS FILE is what keeps them equal to the
 * function. A preset whose foreground was tuned by eye (white on Teal was 2.43:1)
 * fails here, and so does a new family added to themes.ts without the right value.
 * Nothing is exempt: there is no exception list.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readableForeground } from "./customTheme";
import { THEMES } from "./themes";

const CSS = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

/** `--token: value;` declarations of the block opened by exactly `selector`. */
function tokens(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.@]/g, "\\$&");
  const block = CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** The cascade for one theme: base (Blue, Light) → .dark → .family → .dark.family. */
function resolve(family: string | null, dark: boolean): Record<string, string> {
  return {
    ...tokens("@theme"),
    ...(dark ? tokens(".dark") : {}),
    ...(family ? tokens(`.${family}`) : {}),
    ...(family && dark ? tokens(`.dark.${family}`) : {}),
  };
}

function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
const luminance = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(linear(a)), luminance(linear(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const WHITE = "#ffffff";
const BLACK = "#000000";

/** Every selectable family, straight from themes.ts — a family added there is covered without editing this file. */
const COMBOS = THEMES.flatMap((theme) => {
  const family = theme.classes.find((c) => c !== "light" && c !== "dark") ?? null;
  return [false, true].map((dark) => ({ id: `${theme.id}${dark ? "-dark" : ""}`, name: theme.id, family, dark }));
});

/**
 * Hover swaps the background for the preset's own `--color-accent-strong`, a colour
 * fixed by the theme, so the text on it is whatever the rule picked for the accent.
 * Blue + Purple (light) and Lime (light) darken on hover, which is the wrong way
 * for black text: 3.34:1 and 4.21:1, under the 4.5:1 of the resting state. 3:1 —
 * WCAG's minimum for a UI component's states — is the floor asserted here; getting
 * those two to 4.5:1 means choosing a different hover shade, i.e. changing a
 * preset's colour, which is a separate decision.
 */
const HOVER_FLOOR = 3;

describe("every theme", () => {
  it("covers all six families in both modes", () => {
    expect(COMBOS).toHaveLength(12);
  });
});

describe.each(COMBOS)("$id", ({ family, dark }) => {
  const t = resolve(family, dark);
  const accent = t["--color-accent"]!;
  const fg = t["--color-accent-fg"]!;

  it("defines every accent token as a #rrggbb colour", () => {
    for (const name of ["--color-accent", "--color-accent-strong", "--color-accent-fg"]) {
      expect(t[name], name).toMatch(/^#[\da-f]{6}$/i);
    }
  });

  it("uses the same contrast-aware foreground as a Custom theme would for this accent", () => {
    expect(fg.toLowerCase()).toBe(readableForeground(accent));
  });

  it("meets WCAG AA (4.5:1) for the button text at rest", () => {
    expect(contrast(accent, fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("stays legible on hover", () => {
    expect(contrast(t["--color-accent-strong"]!, fg)).toBeGreaterThanOrEqual(HOVER_FLOOR);
  });
});

/** The presets that used to fall short, and the ones the rule left alone — pinned so a change is deliberate. */
describe("the formerly insufficient presets", () => {
  const resting = (family: string | null, dark: boolean) => {
    const t = resolve(family, dark);
    return { fg: t["--color-accent-fg"]!.toLowerCase(), ratio: contrast(t["--color-accent"]!, t["--color-accent-fg"]!) };
  };

  it.each([
    ["Teal", "teal", 8], //            was 2.43:1 with white
    ["Lime", "lime", 6], //            was 3.09:1 with white
    ["Blue + Purple", "bluePurple", 4.6], // was 4.47:1 with white — the DEFAULT theme
  ])("%s (light) now takes black text", (_name, family, atLeast) => {
    const r = resting(family, false);
    expect(r.fg).toBe(BLACK);
    expect(r.ratio).toBeGreaterThanOrEqual(atLeast);
  });

  it.each([
    ["Blue", null],
    ["Red / Rose", "rose"],
    ["Purple", "purple"],
  ])("%s (light) keeps white text — the rule already picks it", (_name, family) => {
    expect(resting(family, false).fg).toBe(WHITE);
  });

  it.each([null, "bluePurple", "rose", "purple", "teal", "lime"])("dark %s takes black text", (family) => {
    expect(resting(family, true).fg).toBe(BLACK);
  });
});
