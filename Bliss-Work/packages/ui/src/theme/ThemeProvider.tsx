import { createContext, useContext, useLayoutEffect, useState } from "react";
import { type ThemeId, isThemeId, darkCounterpart, defaultThemeFor } from "./themes";
import { applyTheme } from "./applyTheme";
import {
  CUSTOM_THEME_KEY,
  isCustomColors,
  isCustomThemeActive,
  persistCustomTheme,
  persistCustomThemeActive,
  removeStoredCustomTheme,
  readStoredCustomTheme,
  type CustomTheme,
} from "./customTheme";

export type { ThemeId as Theme };

/** Legacy combined account preference, read only to migrate custom palettes. */
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
  clearCustomTheme: () => void;
  /** Update only the shared definition; the selected theme remains device-local. */
  applyRemoteCustomTheme: (theme: CustomTheme | null) => void;
}>({
  theme: defaultThemeFor(false),
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
  customTheme: null,
  customThemeActive: false,
  saveCustomTheme: () => {},
  clearCustomTheme: () => {},
  applyRemoteCustomTheme: () => {},
});

const THEME_KEY = "tb-theme";

/** True when this device has a cached theme choice or custom definition. */
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

export function ThemeProvider({
  children,
  authenticated = false,
  forceDefault = false,
  onCustomThemeChange,
}: {
  children: React.ReactNode;
  /** Persisted user preferences are not read or applied until auth is confirmed. */
  authenticated?: boolean;
  /**
   * True while the current screen must always show the fixed Light + Blue/
   * Purple default regardless of what's stored — e.g. the caller's
   * Login/Signup pages, which must read as on-brand BlissWork before anyone
   * has signed in, not whatever a previous session on this device (or a
   * different account) last picked. This provider has no notion of routes
   * itself (it lives in a route-agnostic package); the caller decides when to
   * pass this, from wherever it does know the current route.
   *
  * For an authenticated caller, the selected theme continues to be tracked
  * underneath — `setTheme`/`toggle` still work, and context values report the
  * real selection — while only the DOM classes use the default. Leaving a
  * forced-default route restores the real theme without a separate step.
   */
  forceDefault?: boolean;
  /**
    * Called only when the shared custom palette definition changes or is
    * deleted. Preset selection, appearance, and Custom activation are local.
   */
    onCustomThemeChange?: (theme: CustomTheme | null) => void;
}) {
  const [theme, setThemeState] = useState<ThemeId>(() => authenticated ? readStoredTheme() : defaultThemeFor(false));
  const [customTheme, setCustomTheme] = useState<CustomTheme | null>(() => authenticated ? readStoredCustomTheme() : null);
  const [customThemeSelected, setCustomThemeActive] = useState(() => authenticated && isCustomThemeActive());
  // "Custom" is the active theme only while there is a valid palette to be
  // active. The selection is the explicit flag above — never inferred from the
  // palette's colours — but a flag left behind with no (or an unreadable)
  // palette must not select a theme that cannot render: that read as "Custom"
  // in the Settings description while checking nothing in the menu at all.
  const customThemeActive = customThemeSelected && customTheme !== null;

  useLayoutEffect(() => {
    if (!authenticated) {
      setThemeState(defaultThemeFor(false));
      setCustomTheme(null);
      setCustomThemeActive(false);
      return;
    }
    setThemeState(readStoredTheme());
    setCustomTheme(readStoredCustomTheme());
    setCustomThemeActive(isCustomThemeActive());
  }, [authenticated]);

  useLayoutEffect(() => {
    const useDefault = !authenticated || forceDefault;
    applyTheme(
      document.documentElement,
      useDefault ? defaultThemeFor(false) : theme,
      !useDefault && customThemeActive ? customTheme : null,
    );
  }, [authenticated, customTheme, customThemeActive, forceDefault, theme]);

  const setTheme = (next: ThemeId) => {
    if (!authenticated) return;
    persistTheme(next);
    setThemeState(next);
    persistCustomThemeActive(false);
    setCustomThemeActive(false);
  };

  const saveCustomTheme = (next: CustomTheme) => {
    if (!authenticated) return;
    const changed = !customTheme || customTheme.colors.length !== next.colors.length ||
      customTheme.colors.some((color, index) => color !== next.colors[index]);
    persistCustomTheme(next);
    persistCustomThemeActive(true);
    setCustomTheme(next);
    setCustomThemeActive(true);
    if (changed) onCustomThemeChange?.({ colors: [...next.colors] });
  };

  const clearCustomTheme = () => {
    if (!authenticated) return;
    removeStoredCustomTheme();
    persistCustomThemeActive(false);
    setCustomTheme(null);
    setCustomThemeActive(false);
    onCustomThemeChange?.(null);
  };

  /** Profile → Dark Mode / Settings → Theme: flips the CURRENT family's own
   *  light↔dark pair, never a generic default — Purple Light → Purple Dark →
   *  (toggled again) → Purple Light again, exactly whichever family was
   *  selected. */
  const toggle = () => {
    if (!authenticated) return;
    const next = darkCounterpart(theme);
    persistTheme(next);
    setThemeState(next);
  };

  const applyRemoteCustomTheme = (remote: CustomTheme | null) => {
    if (!authenticated) return;
    const nextCustom = remote && isCustomColors(remote.colors) ? { colors: [...remote.colors] } : null;
    if (nextCustom) persistCustomTheme(nextCustom);
    else removeStoredCustomTheme();
    setCustomTheme(nextCustom);
    if (!nextCustom) {
      persistCustomThemeActive(false);
      setCustomThemeActive(false);
    }
  };

  const isDark = theme.endsWith("-dark");

  return (
    <ThemeCtx.Provider
      value={{ theme, isDark, setTheme, toggle, customTheme, customThemeActive, saveCustomTheme, clearCustomTheme, applyRemoteCustomTheme }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
