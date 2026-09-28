import { createContext, useContext, useEffect, useState } from "react";
import { type ThemeId, isThemeId, themeClasses, darkCounterpart, defaultThemeFor, ALL_THEME_CLASSES } from "./themes";
import {
  CUSTOM_THEME_CLASS,
  CUSTOM_THEME_KEY,
  customThemeStyle,
  isCustomColors,
  isCustomThemeActive,
  persistCustomTheme,
  persistCustomThemeActive,
  readStoredCustomTheme,
  type CustomTheme,
} from "./customTheme";

export type { ThemeId as Theme };

/** Everything that decides which theme is on screen, in the shape it travels
 *  between devices (auth-svc's `themePrefs`). `theme` is the full id, so the
 *  Light/Dark choice syncs along with the colour family; it is a bare string
 *  here because a newer client may have written an id this build does not know
 *  yet — `applyRemote` ignores what `isThemeId` rejects. */
export interface ThemePrefs {
  theme: string;
  customColors: string[] | null;
  customActive: boolean;
}

const ThemeCtx = createContext<{
  theme: ThemeId;
  isDark: boolean;
  setTheme: (theme: ThemeId) => void;
  toggle: () => void;
  customTheme: CustomTheme | null;
  customThemeActive: boolean;
  saveCustomTheme: (theme: CustomTheme) => void;
  /** The current selection, in the shape `onPrefsChange` reports it. */
  prefs: ThemePrefs;
  /** Adopt a selection made on another device. Applies and caches it exactly
   *  like a local pick, but does NOT report it back through `onPrefsChange` —
   *  that would echo it straight back to the server it came from. */
  applyRemote: (prefs: ThemePrefs) => void;
}>({
  theme: defaultThemeFor(false),
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
  customTheme: null,
  customThemeActive: false,
  saveCustomTheme: () => {},
  prefs: { theme: defaultThemeFor(false), customColors: null, customActive: false },
  applyRemote: () => {},
});

const THEME_KEY = "tb-theme";

/** True once this browser has ever recorded a theme choice of its own (as
 *  opposed to just showing the default). Cross-device sync uses it to tell a
 *  device with a real preference to publish from one that merely hasn't picked
 *  anything and should adopt whatever the account already has. */
export function hasStoredThemeChoice(): boolean {
  try {
    return localStorage.getItem(THEME_KEY) !== null || localStorage.getItem(CUSTOM_THEME_KEY) !== null;
  } catch {
    return false;
  }
}

/** Read the persisted theme, validating the stored value instead of trusting a
 *  bare `as ThemeId` cast (a tampered/corrupted entry would otherwise pass).
 *  No stored value — a brand-new visitor, a new browser/device/session, or
 *  storage that's unavailable (private mode / disabled cookies) — resolves to
 *  the fixed Light + Blue/Purple default, never the OS/browser's dark-mode
 *  preference. A value from BEFORE this theme system existed (e.g. the old
 *  "light" / "graphite-lime", or the retired "default" id) is no longer a
 *  valid id either, and falls through the same way — a graceful migration to
 *  the current default family rather than a special case. */
function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v && isThemeId(v) ? v : defaultThemeFor(false);
  } catch {
    return defaultThemeFor(false);
  }
}

function persistTheme(theme: ThemeId) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The manual choice still applies for this session.
  }
}

function toPrefs(theme: ThemeId, customTheme: CustomTheme | null, customThemeActive: boolean): ThemePrefs {
  return {
    theme,
    customColors: customTheme?.colors ?? null,
    customActive: customThemeActive && customTheme !== null,
  };
}

export function ThemeProvider({
  children,
  forceDefault = false,
  onPrefsChange,
}: {
  children: React.ReactNode;
  /**
   * True while the current screen must always show the fixed Light + Blue/
   * Purple default regardless of what's stored — e.g. the caller's
   * Login/Signup pages, which must read as on-brand BlissWork before anyone
   * has signed in, not whatever a previous session on this device (or a
   * different account) last picked. This provider has no notion of routes
   * itself (it lives in a route-agnostic package); the caller decides when to
   * pass this, from wherever it does know the current route.
   *
   * The stored/selected theme keeps being tracked normally underneath —
   * `setTheme`/`toggle` still work exactly as before, and `theme`/`isDark`
   * in the context value still report the REAL selection — only the DOM
   * classes the effect below writes are affected. That's what makes leaving
   * a forced-default screen automatic: the moment the caller passes
   * `forceDefault={false}` again, this effect re-runs and the real theme is
   * back on screen with no separate restoration step anywhere.
   */
  forceDefault?: boolean;
  /**
   * Called with the new selection after every change the person makes here
   * (an accent pick, Light/Dark, saving or activating the custom theme) — the
   * hook the caller uses to mirror it to the account so their other devices
   * follow. This provider lives in a package with no API client, so it only
   * reports; where the report goes is the caller's business.
   */
  onPrefsChange?: (prefs: ThemePrefs) => void;
}) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);
  const [customTheme, setCustomTheme] = useState<CustomTheme | null>(readStoredCustomTheme);
  const [customThemeSelected, setCustomThemeActive] = useState(isCustomThemeActive);
  // "Custom" is the active theme only while there is a valid palette to be
  // active. The selection is the explicit flag above — never inferred from the
  // palette's colours — but a flag left behind with no (or an unreadable)
  // palette must not select a theme that cannot render: that read as "Custom"
  // in the Settings description while checking nothing in the menu at all.
  const customThemeActive = customThemeSelected && customTheme !== null;

  useEffect(() => {
    const root = document.documentElement;
    const effective = forceDefault ? defaultThemeFor(false) : theme;
    root.classList.remove(...ALL_THEME_CLASSES);
    root.classList.add(...themeClasses(effective));
    root.classList.remove(CUSTOM_THEME_CLASS);
    for (const property of [
      "--color-accent",
      "--color-accent-strong",
      "--color-accent-fg",
      "--color-accent-soft",
      "--color-brand-from",
      "--color-brand-mid",
      "--color-brand-to",
      "--color-brand-gradient",
    ]) {
      root.style.removeProperty(property);
    }
    if (!forceDefault && customThemeActive && customTheme) {
      root.classList.add(CUSTOM_THEME_CLASS);
      for (const [property, value] of Object.entries(customThemeStyle(customTheme))) {
        root.style.setProperty(property, value);
      }
    }
  }, [customTheme, customThemeActive, forceDefault, theme]);

  const publish = (next: { theme: ThemeId; customTheme: CustomTheme | null; customThemeActive: boolean }) => {
    onPrefsChange?.(toPrefs(next.theme, next.customTheme, next.customThemeActive));
  };

  const setTheme = (next: ThemeId) => {
    persistTheme(next);
    setThemeState(next);
    persistCustomThemeActive(false);
    setCustomThemeActive(false);
    publish({ theme: next, customTheme, customThemeActive: false });
  };

  const saveCustomTheme = (next: CustomTheme) => {
    persistCustomTheme(next);
    persistCustomThemeActive(true);
    setCustomTheme(next);
    setCustomThemeActive(true);
    publish({ theme, customTheme: next, customThemeActive: true });
  };

  /** Profile → Dark Mode / Settings → Theme: flips the CURRENT family's own
   *  light↔dark pair, never a generic default — Purple Light → Purple Dark →
   *  (toggled again) → Purple Light again, exactly whichever family was
   *  selected. */
  const toggle = () => {
    const next = darkCounterpart(theme);
    persistTheme(next);
    setThemeState(next);
    publish({ theme: next, customTheme, customThemeActive });
  };

  const applyRemote = (remote: ThemePrefs) => {
    const nextTheme = isThemeId(remote.theme) ? remote.theme : theme;
    const nextCustom = isCustomColors(remote.customColors) ? { colors: remote.customColors } : null;
    const nextActive = remote.customActive && nextCustom !== null;
    persistTheme(nextTheme);
    setThemeState(nextTheme);
    if (nextCustom) persistCustomTheme(nextCustom);
    setCustomTheme(nextCustom);
    persistCustomThemeActive(nextActive);
    setCustomThemeActive(nextActive);
  };

  const isDark = theme.endsWith("-dark");
  const prefs = toPrefs(theme, customTheme, customThemeActive);

  return (
    <ThemeCtx.Provider
      value={{ theme, isDark, setTheme, toggle, customTheme, customThemeActive, saveCustomTheme, prefs, applyRemote }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
