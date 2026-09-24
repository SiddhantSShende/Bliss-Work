export interface CustomTheme {
  name: string;
  colors: string[];
}

export const CUSTOM_THEME_KEY = "tb-custom-theme";
export const CUSTOM_THEME_ACTIVE_KEY = "tb-custom-theme-active";
export const CUSTOM_THEME_CLASS = "custom-theme";

const HEX_COLOR = /^#[\da-fA-F]{6}$/;

export function isCustomTheme(value: unknown): value is CustomTheme {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; colors?: unknown };
  return (
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    Array.isArray(candidate.colors) &&
    candidate.colors.length >= 1 &&
    candidate.colors.length <= 3 &&
    candidate.colors.every((color) => typeof color === "string" && HEX_COLOR.test(color))
  );
}

export function customThemeGradient(colors: readonly string[]): string {
  const stops = colors.length === 1 ? colors[0]! : colors.join(", ");
  return colors.length === 1 ? stops : `linear-gradient(135deg, ${stops})`;
}

export function customThemeStyle(theme: CustomTheme): Record<string, string> {
  const [first, ...rest] = theme.colors;
  const last = rest[rest.length - 1] ?? first;
  const middle = theme.colors[1] ?? last!;
  return {
    "--color-accent": first!,
    "--color-accent-strong": first!,
    "--color-accent-fg": "#ffffff",
    "--color-accent-soft": `color-mix(in srgb, ${first} 12%, white)`,
    "--color-brand-from": first!,
    "--color-brand-mid": middle,
    "--color-brand-to": last!,
    "--color-brand-gradient": customThemeGradient(theme.colors),
  };
}

export function readStoredCustomTheme(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCustomTheme(parsed) ? parsed : null;
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
