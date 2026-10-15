import { readableForeground, relativeLuminance, type CustomTheme } from "./customTheme";

/**
 * A Custom theme is a TOKEN SET, nothing else. It supplies the same CSS custom
 * properties a preset family declares in theme.css (`.rose`, `.dark.rose`, …) and
 * the components read them exactly as they read a preset's — there is no
 * custom-only class, selector or component branch anywhere.
 *
 * Every property a preset family varies is produced here, so no preset value can
 * show through under a Custom theme (see applyTheme.ts, which also drops the
 * family class while Custom is active):
 *
 *   neutrals   --color-surface/-muted/-fg (light), plus -bg/-surface-2/-border
 *              and the glass tokens (dark — light shares the :root neutrals)
 *   accent     --color-accent, -strong, -fg, -soft
 *   brand      --color-brand-from/-mid/-to  (the gradient's three stops)
 *   charts     --color-chart-*, --color-heat-0..5, rotated to the accent's hue
 *
 * `--color-fg` is the one neutral that is NOT always fixed: a two-colour theme
 * uses the 2nd pick and a three-colour theme the 3rd as the primary text colour
 * (see pickTextColor below), nudged for contrast if needed. A one-colour theme
 * has no 2nd/3rd pick, so it keeps the fixed neutral every preset family also
 * uses — the rest of the neutral values (kept equal to theme.css by
 * customThemeTokens.test.ts) always do, so Custom Light / Custom Dark have the
 * same surfaces and borders as Preset Light / Preset Dark and differ only in
 * the colours the person chose.
 */
const LIGHT_NEUTRALS = {
  "--color-surface": "#ffffff",
  "--color-muted": "#71717a",
  "--color-fg": "#18181b",
} as const;

const DARK_NEUTRALS = {
  "--color-bg": "#09090b",
  "--color-surface": "#18181b",
  "--color-muted": "#a1a1aa",
  "--color-fg": "#fafafa",
} as const;

/** The shared light `--color-bg` every family keeps (theme.css's bare `:root`).
 *  LIGHT_NEUTRALS doesn't repeat it, since Custom light doesn't override it
 *  either, but the text-contrast check below still needs to measure against it. */
const LIGHT_BG = "#fafafa";

/** Exposed so the test can hold them equal to the presets' neutrals in theme.css. */
export const CUSTOM_NEUTRALS = { light: LIGHT_NEUTRALS, dark: DARK_NEUTRALS };

/** WCAG contrast ratio between two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `hex` blended `amount` of the way (0–1) toward `toward`, channel by channel. */
function blendToward(hex: string, toward: string, amount: number): string {
  const channelsOf = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r1, g1, b1] = channelsOf(hex);
  const [r2, g2, b2] = channelsOf(toward);
  const lerp = (from: number, to: number) => Math.round(from + (to - from) * amount);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(lerp(r1!, r2!))}${toHex(lerp(g1!, g2!))}${toHex(lerp(b1!, b2!))}`;
}

/**
 * `picked` nudged toward black (light mode) or white (dark mode) in 5% steps
 * until it reads at WCAG AA (4.5:1) against both the page background and the
 * card surface. The configured colour itself never changes — only this
 * derived token does, and only when the pick alone isn't readable enough.
 */
function readableBodyText(picked: string, dark: boolean): string {
  const backgrounds = dark
    ? [DARK_NEUTRALS["--color-bg"], DARK_NEUTRALS["--color-surface"]]
    : [LIGHT_BG, LIGHT_NEUTRALS["--color-surface"]];
  const worstRatio = (hex: string) => Math.min(...backgrounds.map((bg) => contrastRatio(hex, bg)));
  if (worstRatio(picked) >= 4.5) return picked;
  const toward = dark ? "#ffffff" : "#000000";
  for (let amount = 0.05; amount < 1; amount += 0.05) {
    const adjusted = blendToward(picked, toward, amount);
    if (worstRatio(adjusted) >= 4.5) return adjusted;
  }
  return toward;
}

/**
 * The primary text colour: the 2nd pick for a two-colour theme, the 3rd for a
 * three-colour one — per BlissWork's requirement that the text colour track
 * whichever pick is "last" among the non-accent choices — contrast-adjusted by
 * readableBodyText. A one-colour theme has no 2nd/3rd pick, so it falls back to
 * the fixed neutral every preset family also uses.
 */
function pickTextColor(colors: readonly string[], dark: boolean): string {
  const picked = colors.length === 3 ? colors[2] : colors.length === 2 ? colors[1] : undefined;
  return picked ? readableBodyText(picked, dark) : (dark ? DARK_NEUTRALS : LIGHT_NEUTRALS)["--color-fg"];
}

/** [lightness, chroma] steps — the same ramps every preset family uses, at the accent's own hue. */
const RAMPS = {
  light: {
    ink: [0.58, 0.22], context: [0.72, 0.02], grid: [0.93, 0.01],
    heat: [[0.965, 0.012], [0.9, 0.05], [0.82, 0.098], [0.72, 0.16], [0.63, 0.19], [0.52, 0.2]],
  },
  dark: {
    ink: [0.66, 0.216], context: [0.5, 0.02], grid: [0.3, 0.01],
    heat: [[0.24, 0.012], [0.32, 0.06], [0.42, 0.11], [0.52, 0.16], [0.62, 0.19], [0.74, 0.16]],
  },
} as const;

/** OKLCH chroma and hue (degrees) of a #rrggbb colour. */
export function oklchOf(hex: string): { chroma: number; hue: number } {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(a, bb), hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function chartTokens(accent: string, dark: boolean): Record<string, string> {
  const { chroma, hue } = oklchOf(accent);
  // A grey accent gets a grey ramp rather than an arbitrary hue at full chroma.
  const k = Math.min(1, chroma / 0.12);
  const ramp = dark ? RAMPS.dark : RAMPS.light;
  const step = ([l, c]: readonly [number, number]) => `oklch(${l} ${+(c * k).toFixed(3)} ${hue.toFixed(1)})`;
  return {
    "--color-chart-ink": step(ramp.ink),
    "--color-chart-context": step(ramp.context),
    "--color-chart-grid": step(ramp.grid),
    ...Object.fromEntries(ramp.heat.map((s, i) => [`--color-heat-${i}`, step(s)])),
  };
}

/**
 * The full token set for a Custom theme in light or dark. `dark` comes from the
 * same light/dark axis the presets use, so the Dark Mode toggle works on Custom
 * exactly as it does on a preset.
 */
export function customThemeStyle(theme: CustomTheme, dark = false): Record<string, string> {
  const [first, ...rest] = theme.colors;
  const last = rest[rest.length - 1] ?? first!;
  // Two colours have no explicit middle stop; blending them keeps the three-stop
  // gradient identical to the plain two-stop one.
  const middle = theme.colors.length === 3 ? theme.colors[1]! : `color-mix(in oklab, ${first} 50%, ${last})`;
  const foreground = readableForeground(first!);
  const accent = first!;
  return {
    ...(dark ? DARK_NEUTRALS : LIGHT_NEUTRALS),
    "--color-fg": pickTextColor(theme.colors, dark),
    ...(dark && {
      "--color-surface-2": `color-mix(in srgb, ${accent} 6%, ${DARK_NEUTRALS["--color-surface"]})`,
      "--color-border": `color-mix(in srgb, ${accent} 18%, ${DARK_NEUTRALS["--color-surface"]})`,
      "--glass-bg": "rgba(24, 24, 27, 0.6)",
      "--glass-border": `color-mix(in srgb, ${accent} 10%, transparent)`,
      "--glass-shadow": "0 8px 32px rgba(0, 0, 0, 0.5)",
    }),
    "--color-accent": accent,
    // The hover shade (`hover:bg-accent-strong` on every accent button).
    // Shifted 12% AWAY from the text colour — lighter under black text, darker
    // under white — so hovering can only raise the text's contrast, never lower
    // it (a fixed direction would dip below 4.5:1 for mid-tones).
    "--color-accent-strong": `color-mix(in srgb, ${accent} 88%, ${foreground === "#000000" ? "white" : "black"})`,
    "--color-accent-fg": foreground,
    "--color-accent-soft": dark
      ? `color-mix(in srgb, ${accent} 34%, ${DARK_NEUTRALS["--color-bg"]})`
      : `color-mix(in srgb, ${accent} 12%, white)`,
    "--color-brand-from": accent,
    "--color-brand-mid": middle,
    "--color-brand-to": last,
    ...chartTokens(accent, dark),
  };
}

/** Every custom property a Custom theme may set inline — what applyTheme clears when it is switched away from. */
export const CUSTOM_THEME_PROPERTIES: readonly string[] = [
  ...new Set([
    ...Object.keys(customThemeStyle({ colors: ["#000000"] }, false)),
    ...Object.keys(customThemeStyle({ colors: ["#000000"] }, true)),
  ]),
];
