import { createContext, useContext, useEffect, useState } from "react";
import { type ThemeId, isThemeId, themeClasses, darkCounterpart, defaultThemeFor, ALL_THEME_CLASSES } from "./themes";

export type { ThemeId as Theme };

const ThemeCtx = createContext<{
  theme: ThemeId;
  isDark: boolean;
  setTheme: (theme: ThemeId) => void;
  toggle: () => void;
}>({
  theme: "default",
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
});

const THEME_KEY = "tb-theme";

function systemTheme(): ThemeId {
  return defaultThemeFor(
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

/** Read the persisted theme, validating the stored value instead of trusting a
 *  bare `as ThemeId` cast (a tampered/corrupted entry would otherwise pass),
 *  and tolerating storage being unavailable (private mode / disabled cookies).
 *  A value from BEFORE this theme system existed (e.g. the old "light" /
 *  "graphite-lime") is no longer a valid id either, and falls through the
 *  same way — a graceful migration to the retained default family rather
 *  than a special case. */
function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v && isThemeId(v) ? v : systemTheme();
  } catch {
    return systemTheme();
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
   * True while the current screen must show the default BlissWork theme
   * regardless of what's stored — e.g. the caller's Login/Signup pages. This
   * provider has no notion of routes itself (it lives in a route-agnostic
   * package); the caller decides when to pass this, from wherever it does
   * know the current route.
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
  // Tracked independently of `theme` so a forced-default screen still
  // follows the OS/browser's light/dark preference live (STEP 5 of the task
  // this shipped with: a forced screen may still support dark mode, it just
  // never shows the user's chosen accent family) — `theme` itself only
  // updates from a system-preference change when nothing has been
  // explicitly stored (see the listener below), which forceDefault must not
  // depend on.
  const [systemDark, setSystemDark] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const root = document.documentElement;
    const effective = forceDefault ? defaultThemeFor(systemDark) : theme;
    root.classList.remove(...ALL_THEME_CLASSES);
    root.classList.add(...themeClasses(effective));
  }, [theme, forceDefault, systemDark]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
      // Auto-follow system for the REAL selection only when the user has
      // never made an explicit choice — unchanged from before. A
      // forced-default screen still benefits from `systemDark` above
      // regardless of whether a real theme is stored underneath.
      try {
        if (localStorage.getItem(THEME_KEY)) return;
      } catch {
        // Follow the system when storage is unavailable.
      }
      setThemeState(defaultThemeFor(event.matches));
    };
    media.addEventListener?.("change", onSystemThemeChange);
    return () => media.removeEventListener?.("change", onSystemThemeChange);
  }, []);

  const setTheme = (next: ThemeId) => {
    persistTheme(next);
    setThemeState(next);
  };

  /** Profile → Dark Mode: flips the CURRENT family's own light↔dark pair,
   *  never a generic default — Purple Light → Purple Dark → (toggled again)
   *  → Purple Light again, exactly whichever family was selected. */
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
