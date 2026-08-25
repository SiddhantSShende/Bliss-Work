/**
 * Single source of truth for every selectable theme. Settings' theme menu,
 * ThemeProvider's persistence/validation, and the FOUC-prevention scripts
 * (apps/web + apps/desktop `public/theme-init.js`, which can't import this
 * module since they run before any bundler does) all key off the same
 * `classes` — two independent axes layered onto <html>:
 *   - "dark"  → the light/dark selectors already used throughout theme.css
 *               (brand-mesh, shadows, glass tints).
 *   - "lime"  → the Graphite+Lime palette overrides on top of that.
 *
 * To add a theme: add a ThemeDef here (pick which of "dark"/"lime" it
 * layers, or introduce a new axis) and add the matching CSS block in
 * theme.css. Nothing else needs to change — Settings' menu and the swatch
 * previews read this list directly.
 */
export type ThemeId = "light" | "dark" | "graphite-lime" | "graphite-lime-dark";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  classes: readonly string[];
}

const DEFAULT_THEME: ThemeDef = { id: "light", name: "Light Theme", classes: ["light"] };

/** Every theme offered in Settings → Theme, in menu order. */
export const THEMES: readonly ThemeDef[] = [
  DEFAULT_THEME,
  { id: "graphite-lime", name: "Graphite + Lime", classes: ["light", "lime"] },
  { id: "graphite-lime-dark", name: "Graphite + Lime (Dark)", classes: ["dark", "lime"] },
];

/** Not offered in Settings — kept only as the ProfileMenu quick-toggle's
 *  dark counterpart for the plain Light Theme, using the app's original
 *  dark palette (theme.css `.dark`) that predates the Graphite+Lime themes. */
const LEGACY_DARK: ThemeDef = { id: "dark", name: "Dark", classes: ["dark"] };

const ALL_THEMES: readonly ThemeDef[] = [...THEMES, LEGACY_DARK];
const ALL_THEME_IDS: readonly ThemeId[] = ALL_THEMES.map((t) => t.id);

export function isThemeId(value: string): value is ThemeId {
  return (ALL_THEME_IDS as readonly string[]).includes(value);
}

export function themeClasses(id: ThemeId): readonly string[] {
  return (ALL_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME).classes;
}

export function themeName(id: ThemeId): string {
  return (ALL_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME).name;
}
