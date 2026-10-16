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

/** The account-wide theme document: preset (which also encodes light/dark,
 *  e.g. "rose-dark"), whether Custom is the active choice, and the custom
 *  palette definition. Mirrors auth-svc's ThemePrefs shape. */
export interface ThemePrefsSnapshot {
  theme: ThemeId;
  customActive: boolean;
  customTheme: CustomTheme | null;
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
  /** Apply the account's current document, exactly as another device left it
   *  (preset, light/dark, Custom activation, and the palette). */
  applyRemotePrefs: (prefs: ThemePrefsSnapshot) => void;
}>({
  theme: defaultThemeFor(false),
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
  customTheme: null,
  customThemeActive: false,
  saveCustomTheme: () => {},
  clearCustomTheme: () => {},
  applyRemotePrefs: () => {},
});

const THEME_KEY = "tb-theme";
const THEME_OWNER_KEY = "tb-theme-owner";

function canReadStoredTheme(accountId?: string): boolean {
  if (!accountId) return true;
  try {
    const owner = localStorage.getItem(THEME_OWNER_KEY);
    return owner === null || owner === accountId;
  } catch {
    return true;
  }
}

function rememberThemeOwner(accountId?: string): void {
  if (!accountId) return;
  try {
    localStorage.setItem(THEME_OWNER_KEY, accountId);
  } catch {
    // The in-memory theme still applies when storage is unavailable.
  }
}

function clearStoredThemeChoice(): void {
  try {
    localStorage.removeItem(THEME_KEY);
    removeStoredCustomTheme();
    persistCustomThemeActive(false);
  } catch {
    // The next authenticated hydration still starts from the default.
  }
}

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
  accountId,
  forceDefault = false,
  onPrefsChange,
}: {
  children: React.ReactNode;
  /** Persisted user preferences are not read or applied until auth is confirmed. */
  authenticated?: boolean;
  /** Keeps a previous account's origin-wide localStorage choice from leaking. */
  accountId?: string;
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
   * Called after ANY of preset, light/dark, Custom activation, or the custom
   * palette definition changes on this device — the whole account-wide
   * document, every time, so the caller's publish path never has to guess
   * which pieces moved.
   */
  onPrefsChange?: (prefs: ThemePrefsSnapshot) => void;
}) {
  const [theme, setThemeState] = useState<ThemeId>(() => authenticated && canReadStoredTheme(accountId) ? readStoredTheme() : defaultThemeFor(false));
  const [customTheme, setCustomTheme] = useState<CustomTheme | null>(() => authenticated && canReadStoredTheme(accountId) ? readStoredCustomTheme() : null);
  const [customThemeSelected, setCustomThemeActive] = useState(() => authenticated && canReadStoredTheme(accountId) && isCustomThemeActive());
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
    if (!canReadStoredTheme(accountId)) clearStoredThemeChoice();
    const canUseStoredTheme = canReadStoredTheme(accountId);
    setThemeState(canUseStoredTheme ? readStoredTheme() : defaultThemeFor(false));
    setCustomTheme(canUseStoredTheme ? readStoredCustomTheme() : null);
    setCustomThemeActive(canUseStoredTheme && isCustomThemeActive());
    rememberThemeOwner(accountId);
  }, [accountId, authenticated]);

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
    onPrefsChange?.({ theme: next, customActive: false, customTheme });
  };

  const saveCustomTheme = (next: CustomTheme) => {
    if (!authenticated) return;
    persistCustomTheme(next);
    persistCustomThemeActive(true);
    setCustomTheme(next);
    setCustomThemeActive(true);
    onPrefsChange?.({ theme, customActive: true, customTheme: { colors: [...next.colors] } });
  };

  const clearCustomTheme = () => {
    if (!authenticated) return;
    removeStoredCustomTheme();
    persistCustomThemeActive(false);
    setCustomTheme(null);
    setCustomThemeActive(false);
    onPrefsChange?.({ theme, customActive: false, customTheme: null });
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
    onPrefsChange?.({ theme: next, customActive: customThemeActive, customTheme });
  };

  /** Apply the account's current document exactly as another device/session
   *  left it — preset, light/dark (folded into the preset id), Custom
   *  activation, and the palette — all at once, so there is never a moment
   *  where only part of a remote change has been applied. An invalid preset id
   *  or palette (a future id this build doesn't know, or corrupted colours)
   *  falls back to the fixed default / no palette rather than crashing or
   *  rendering a theme that cannot actually apply. */
  const applyRemotePrefs = (remote: ThemePrefsSnapshot) => {
    if (!authenticated) return;
    const nextTheme = isThemeId(remote.theme) ? remote.theme : defaultThemeFor(false);
    const nextCustom =
      remote.customTheme && isCustomColors(remote.customTheme.colors)
        ? { colors: [...remote.customTheme.colors] }
        : null;
    const nextActive = remote.customActive && nextCustom !== null;
    persistTheme(nextTheme);
    if (nextCustom) persistCustomTheme(nextCustom);
    else removeStoredCustomTheme();
    persistCustomThemeActive(nextActive);
    rememberThemeOwner(accountId);
    setThemeState(nextTheme);
    setCustomTheme(nextCustom);
    setCustomThemeActive(nextActive);
  };

  const isDark = theme.endsWith("-dark");

  return (
    <ThemeCtx.Provider
      value={{ theme, isDark, setTheme, toggle, customTheme, customThemeActive, saveCustomTheme, clearCustomTheme, applyRemotePrefs }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
