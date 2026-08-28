/**
 * Single source of truth for every selectable theme. Settings' theme menu,
 * ThemeProvider's persistence/validation/dark-toggle, the sticky-note
 * renderer's own theme sync, and the FOUC-prevention scripts (apps/web +
 * apps/desktop `public/theme-init.js`, which can't import this module since
 * they run before any bundler does) all key off the same `classes` — two
 * independent axes layered onto <html>:
 *   - "dark"                → the light/dark selectors already used
 *                              throughout theme.css (brand-mesh, shadows,
 *                              glass tints).
 *   - one of the FAMILY_CLASSES below, or none → which colour family. "Blue"
 *     is the app's original palette and needs no extra class (bare
 *     `:root`/`.dark` in theme.css already IS Blue); the other three each
 *     layer their own class on top, exactly like "Blue" would if it had one.
 *
 * Only the four LIGHT ids are offered in Settings — see THEMES vs.
 * DARK_THEMES below. The dark ids exist only to be reached via
 * ThemeProvider's toggle (Profile → Dark Mode), never picked directly: a
 * dark id selected directly would have no "which light theme was this dark
 * mode for" to return to when Dark Mode is turned back off.
 *
 * To add a theme family: add a light ThemeDef to THEMES and its dark
 * counterpart to DARK_THEMES here, a matching CSS block in theme.css, and
 * list its class in FAMILY_CLASSES. Nothing else needs to change — Settings'
 * menu and the swatch previews read this list directly, and
 * ThemeProvider derives its light↔dark pairing from the two arrays' order.
 */
export type ThemeId =
  | "blue"
  | "blue-dark"
  | "rose"
  | "rose-dark"
  | "purple"
  | "purple-dark"
  | "teal"
  | "teal-dark"
  | "lime"
  | "lime-dark";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  classes: readonly string[];
}

/** The non-"dark" class each family layers on top of the light/dark axis.
 *  Blue has none — see the module doc comment above. */
const FAMILY_CLASSES: Partial<Record<ThemeId, string>> = {
  rose: "rose",
  purple: "purple",
  teal: "teal",
  lime: "lime",
};

/** Every family's light class-set. Family order here is menu order. Lime is
 *  the pre-rework Graphite+Lime palette, brought back as a proper fifth
 *  family (its own light/dark pair, like the other four) rather than the
 *  old system's separate "lime layered on the light/dark axis" toggle —
 *  same accent colours, current architecture. */
const FAMILIES: readonly { id: Exclude<ThemeId, `${string}-dark`>; name: string }[] = [
  { id: "rose", name: "Red / Rose" },
  { id: "blue", name: "Blue" },
  { id: "purple", name: "Purple" },
  { id: "teal", name: "Cyan / Teal" },
  { id: "lime", name: "Lime" },
];

function classesFor(family: string, dark: boolean): readonly string[] {
  const extra = FAMILY_CLASSES[family as ThemeId];
  return [dark ? "dark" : "light", ...(extra ? [extra] : [])];
}

/** Every theme offered in Settings → Theme, in menu order — LIGHT only. See
 *  the module doc comment for why dark ids aren't offered here directly. */
export const THEMES: readonly ThemeDef[] = FAMILIES.map(({ id, name }) => ({
  id,
  name,
  classes: classesFor(id, false),
}));

/** The dark counterpart of each family, in the same order as THEMES. Not
 *  offered in Settings — reached only via ThemeProvider's toggle. */
const DARK_THEMES: readonly ThemeDef[] = FAMILIES.map(({ id, name }) => ({
  id: `${id}-dark` as ThemeId,
  name: `${name} (Dark)`,
  classes: classesFor(id, true),
}));

/** The default theme for anyone with no saved preference (first-ever visit,
 *  or storage unavailable) — see readStoredTheme in ThemeProvider.tsx. Looked
 *  up by id rather than a positional THEMES[n] index so this stays correct if
 *  FAMILIES is ever reordered. */
const DEFAULT_THEME: ThemeDef = THEMES.find((t) => t.id === "purple")!;

const ALL_THEMES: readonly ThemeDef[] = [...THEMES, ...DARK_THEMES];
const ALL_THEME_IDS: readonly ThemeId[] = ALL_THEMES.map((t) => t.id);

/** Every class any theme can apply — what a consumer needs to `remove()`
 *  before applying a new theme's `classes`. Exported so ThemeProvider and the
 *  sticky-note renderer (a separate BrowserWindow, syncing via localStorage
 *  rather than React context) don't each hold their own copy to fall out of
 *  sync — see theme.css's own header comment on why that already happened
 *  once with the desktop/web CSS split. */
export const ALL_THEME_CLASSES: readonly string[] = ["light", "dark", ...Object.values(FAMILY_CLASSES)];

export function isThemeId(value: string): value is ThemeId {
  return (ALL_THEME_IDS as readonly string[]).includes(value);
}

export function themeClasses(id: ThemeId): readonly string[] {
  return (ALL_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME).classes;
}

export function themeName(id: ThemeId): string {
  return (ALL_THEMES.find((t) => t.id === id) ?? DEFAULT_THEME).name;
}

/** The dark counterpart of a theme id, and vice versa — same family, other
 *  mode. Used by ThemeProvider's toggle (Profile → Dark Mode): flipping a
 *  light theme to dark and back always returns to the exact family the
 *  person had selected, never a generic default. */
export function darkCounterpart(id: ThemeId): ThemeId {
  const family = ALL_THEMES.find((t) => t.id === id);
  if (!family) return DEFAULT_THEME.id;
  const isDark = id.endsWith("-dark");
  const baseId = (isDark ? id.slice(0, -"-dark".length) : id) as ThemeId;
  const counterpart = isDark ? baseId : (`${baseId}-dark` as ThemeId);
  return isThemeId(counterpart) ? counterpart : DEFAULT_THEME.id;
}

/** The DEFAULT theme's own light/dark pair — what a first-ever visit (no
 *  stored preference, no OS preference match) resolves to. */
export function defaultThemeFor(dark: boolean): ThemeId {
  return dark ? darkCounterpart(DEFAULT_THEME.id) : DEFAULT_THEME.id;
}
