/** There is exactly one custom theme, so it carries no name of its own — the UI
 *  simply calls it "Custom". */
export interface CustomTheme {
  colors: string[];
}

export const CUSTOM_THEME_KEY = "tb-custom-theme";
export const CUSTOM_THEME_ACTIVE_KEY = "tb-custom-theme-active";

const HEX_COLOR = /^#[\da-fA-F]{6}$/;

/** Whether `colors` is a well-formed custom palette: 1–3 `#rrggbb` entries.
 *  Shared by the stored-value check below and by ThemeProvider's remote sync,
 *  which receives a bare colour list rather than a `CustomTheme`. */
export function isCustomColors(colors: unknown): colors is string[] {
  return (
    Array.isArray(colors) &&
    colors.length >= 1 &&
    colors.length <= 3 &&
    colors.every((color) => typeof color === "string" && HEX_COLOR.test(color))
  );
}

/** Accepts a legacy `{ name, colors }` entry too — customs saved before the
 *  name field was removed are still valid; the stray `name` is simply dropped
 *  the next time the value is read back through `readStoredCustomTheme`. */
export function isCustomTheme(value: unknown): value is CustomTheme {
  if (!value || typeof value !== "object") return false;
  return isCustomColors((value as { colors?: unknown }).colors);
}

export function customThemeGradient(colors: readonly string[]): string {
  const stops = colors.length === 1 ? colors[0]! : colors.join(", ");
  return colors.length === 1 ? stops : `linear-gradient(135deg, ${stops})`;
}

/** Black or white — whichever reads better on `background` (WCAG relative
 *  luminance; white wins at or below 0.179, the point where the two contrast
 *  ratios are equal). The accent colour is user-picked, so a fixed white
 *  foreground is unreadable on a light pick such as yellow. PURE black, not a
 *  near-black: 0.179 is only the crossover for pure black, and it is what
 *  guarantees the better of the two never drops below 4.5:1 (WCAG AA) for any
 *  background. Kept in lock-step with the copy in
 */
/** WCAG relative luminance of a #rrggbb colour (0 = black, 1 = white). Shared by
 *  readableForeground below and by customThemeTokens' body-text contrast check. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableForeground(background: string): string {
  return relativeLuminance(background) > 0.179 ? "#000000" : "#ffffff";
}

export function readStoredCustomTheme(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCustomTheme(parsed) ? { colors: parsed.colors } : null;
  } catch {
    return null;
  }
}

export function persistCustomTheme(theme: CustomTheme): void {
  try {
    localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
  } catch {
    // The manual choice still applies for this session.
  }
}

export function removeStoredCustomTheme(): void {
  try {
    localStorage.removeItem(CUSTOM_THEME_KEY);
  } catch {
    // The in-memory removal still applies for this session.
  }
}

export function isCustomThemeActive(): boolean {
  try {
    return localStorage.getItem(CUSTOM_THEME_ACTIVE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistCustomThemeActive(active: boolean): void {
  try {
    localStorage.setItem(CUSTOM_THEME_ACTIVE_KEY, String(active));
  } catch {
    // The manual choice still applies for this session.
  }
}
