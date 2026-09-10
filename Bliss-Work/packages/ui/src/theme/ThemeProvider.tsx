import { createContext, useContext, useEffect, useState } from "react";
import { type ThemeId, isThemeId, themeClasses, darkCounterpart, defaultThemeFor, ALL_THEME_CLASSES } from "./themes";

export type { ThemeId as Theme };

const ThemeCtx = createContext<{
  theme: ThemeId;
  isDark: boolean;
  setTheme: (theme: ThemeId) => void;
  toggle: () => void;
}>({
  theme: defaultThemeFor(false),
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
});

const THEME_KEY = "tb-theme";

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

export function ThemeProvider({
  children,
  forceDefault = false,
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
}) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    const effective = forceDefault ? defaultThemeFor(false) : theme;
    root.classList.remove(...ALL_THEME_CLASSES);
    root.classList.add(...themeClasses(effective));
  }, [theme, forceDefault]);

  const setTheme = (next: ThemeId) => {
    persistTheme(next);
    setThemeState(next);
  };

  /** Profile → Dark Mode / Settings → Theme: flips the CURRENT family's own
   *  light↔dark pair, never a generic default — Purple Light → Purple Dark →
   *  (toggled again) → Purple Light again, exactly whichever family was
   *  selected. */
  const toggle = () => {
    setThemeState((current) => {
      const next = darkCounterpart(current);
      persistTheme(next);
      return next;
    });
  };

  const isDark = theme.endsWith("-dark");

  return <ThemeCtx.Provider value={{ theme, isDark, setTheme, toggle }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
