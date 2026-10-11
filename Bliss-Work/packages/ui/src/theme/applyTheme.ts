import { type CustomTheme } from "./customTheme";
import { CUSTOM_THEME_PROPERTIES, customThemeStyle } from "./customThemeTokens";
import { ALL_THEME_CLASSES, themeClasses, type ThemeId } from "./themes";

/**
 * Put a theme on `root`. The ONE place a theme becomes DOM state, shared by the
 * main window's ThemeProvider and the sticky-note / meeting-invite windows, so
 * they cannot drift apart.
 *
 * Everything the previous theme left behind is cleared first — its classes AND
 * every inline token a Custom theme may have set — so switching Preset ↔ Custom
 * or Light ↔ Dark never leaves a stale value behind, with no reload.
 *
 * A preset applies its class set (light|dark + family). Custom applies only the
 * light|dark axis and supplies the tokens itself (customThemeTokens.ts): the
 * components, selectors and `.dark` rules in theme.css are the same ones either
 * way, and no preset family's colours are in play to leak through.
 */
export function applyTheme(root: HTMLElement, id: ThemeId, custom: CustomTheme | null): void {
  root.classList.remove(...ALL_THEME_CLASSES);
  for (const property of CUSTOM_THEME_PROPERTIES) root.style.removeProperty(property);
  if (!custom) {
    root.classList.add(...themeClasses(id));
    return;
  }
  const dark = id.endsWith("-dark");
  root.classList.add(dark ? "dark" : "light");
  for (const [property, value] of Object.entries(customThemeStyle(custom, dark))) {
    root.style.setProperty(property, value);
  }
}
