import { createContext, useContext, useEffect, useState } from "react";
import { type ThemeId, isThemeId, themeClasses } from "./themes";

export type { ThemeId as Theme };

const ALL_CLASSES = ["light", "dark", "lime"];

/** The "dark-ish" counterpart of each theme, used by the quick toggle
 *  (ProfileMenu) to flip within the current palette family. */
const DARK_COUNTERPART: Record<ThemeId, ThemeId> = {
  light: "dark",
  dark: "light",
  "graphite-lime": "graphite-lime-dark",
  "graphite-lime-dark": "graphite-lime",
};

const ThemeCtx = createContext<{
  theme: ThemeId;
  isDark: boolean;
  setTheme: (theme: ThemeId) => void;
  toggle: () => void;
}>({
  theme: "light",
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
});

const THEME_KEY = "tb-theme";

function systemTheme(): ThemeId {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Read the persisted theme, validating the stored value instead of trusting a
 *  bare `as ThemeId` cast (a tampered/corrupted entry would otherwise pass),
 *  and tolerating storage being unavailable (private mode / disabled cookies). */
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
    root.classList.remove(...ALL_CLASSES);
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
      setThemeState(event.matches ? "dark" : "light");
    };
    media.addEventListener?.("change", onSystemThemeChange);
    return () => media.removeEventListener?.("change", onSystemThemeChange);
  }, []);

  const setTheme = (next: ThemeId) => {
    persistTheme(next);
    setThemeState(next);
  };

  const toggle = () => {
    setThemeState((current) => {
      const next = DARK_COUNTERPART[current];
      persistTheme(next);
      return next;
    });
  };

  const isDark = theme === "dark" || theme === "graphite-lime-dark";

  return <ThemeCtx.Provider value={{ theme, isDark, setTheme, toggle }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
