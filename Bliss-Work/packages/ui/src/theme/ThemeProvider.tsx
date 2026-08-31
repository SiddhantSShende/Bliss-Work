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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(...ALL_THEME_CLASSES);
    root.classList.add(...themeClasses(theme));
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = (event: MediaQueryListEvent) => {
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
