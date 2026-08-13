import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

/** Read the persisted theme, validating the stored value instead of trusting a
 *  bare `as Theme` cast (a tampered/corrupted entry would otherwise pass), and
 *  tolerating storage being unavailable (private mode / disabled cookies). */
function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem("tb-theme");
    return v === "dark" || v === "light" ? v : "light";
  } catch {
    return "light";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
    try {
      localStorage.setItem("tb-theme", theme);
    } catch {
      /* storage unavailable (private mode / quota) — theme still applies in-session */
    }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
