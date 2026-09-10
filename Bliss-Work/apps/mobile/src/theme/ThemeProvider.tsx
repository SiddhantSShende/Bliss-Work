import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemeColors } from '../constants/theme';
import { DEFAULT_FAMILY, isThemeFamily, paletteFor, type ThemeFamily } from './themes';

export type ThemeMode = 'light' | 'dark';

/** Combined family+mode id, e.g. "bluePurple" / "bluePurple-dark" — mirrors
 *  web's own `ThemeId` shape (packages/ui/src/theme/themes.ts) purely so the
 *  persisted string reads the same way in both places; this app tracks
 *  family and mode as two separate pieces of state internally rather than
 *  parsing this id back apart. */
const STORAGE_KEY = 'tb-theme-id';
/** The old, pre-6-theme storage key (light/dark only, always Purple) — read
 *  once as a migration fallback so a user who already picked Dark doesn't
 *  get silently reset to Light the first time this version runs. Never
 *  written to again. */
const LEGACY_MODE_KEY = 'tb-theme-mode';

interface ThemeContextValue {
  colors: ThemeColors;
  family: ThemeFamily;
  mode: ThemeMode;
  isDark: boolean;
  /** Flips the CURRENT family's own light↔dark pair — never a generic
   *  default — same contract as web's ThemeProvider.toggle(). */
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
  setFamily: (family: ThemeFamily) => void;
}

function idFor(family: ThemeFamily, mode: ThemeMode): string {
  return mode === 'dark' ? `${family}-dark` : family;
}

/** Parses a persisted "family" or "family-dark" id back into its parts,
 *  validating the family against the real family list instead of trusting a
 *  bare cast — a tampered/corrupted/stale (pre-migration) value falls
 *  through to `null` and the caller's own default applies. */
function parseThemeId(id: string | null): { family: ThemeFamily; mode: ThemeMode } | null {
  if (!id) return null;
  const isDark = id.endsWith('-dark');
  const family = isDark ? id.slice(0, -'-dark'.length) : id;
  return isThemeFamily(family) ? { family, mode: isDark ? 'dark' : 'light' } : null;
}

const DEFAULT_VALUE: ThemeContextValue = {
  colors: paletteFor(DEFAULT_FAMILY, false),
  family: DEFAULT_FAMILY,
  mode: 'light',
  isDark: false,
  toggle: () => {},
  setMode: () => {},
  setFamily: () => {},
};

const ThemeCtx = createContext<ThemeContextValue>(DEFAULT_VALUE);

/**
 * The one place mobile decides accent family + light/dark and hands out the
 * active color palette — the RN counterpart to
 * packages/ui/src/theme/ThemeProvider.tsx. CSS custom properties (how web
 * re-themes) don't exist in RN, so every screen/component reads
 * `useThemeColors()` instead of a static import, and re-renders when this
 * changes. No stored preference (first launch, new device, storage
 * unavailable) resolves to Blue + Purple, Light — BlissWork's default,
 * exactly like web's `defaultThemeFor(false)` — never the OS's own
 * light/dark preference.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [family, setFamilyState] = useState<ThemeFamily>(DEFAULT_FAMILY);
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stored = parseThemeId(await AsyncStorage.getItem(STORAGE_KEY));
        if (stored) {
          if (alive) {
            setFamilyState(stored.family);
            setModeState(stored.mode);
          }
          return;
        }
        // Migration: a pre-6-theme install only ever stored a mode (always
        // Purple). Respect that mode once, on the default family, rather
        // than resetting a Dark-mode user back to Light.
        const legacyMode = await AsyncStorage.getItem(LEGACY_MODE_KEY);
        if (alive && legacyMode === 'dark') setModeState('dark');
      } catch {
        // No stored preference is indistinguishable from storage being
        // unavailable — both fall back to the Blue + Purple / Light default
        // already set above.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = (nextFamily: ThemeFamily, nextMode: ThemeMode) => {
    AsyncStorage.setItem(STORAGE_KEY, idFor(nextFamily, nextMode)).catch(() => {
      // The manual choice still applies for this session.
    });
  };

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    persist(family, next);
  };
  const setFamily = (next: ThemeFamily) => {
    setFamilyState(next);
    persist(next, mode);
  };
  const toggle = () => setMode(mode === 'dark' ? 'light' : 'dark');

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors: paletteFor(family, mode === 'dark'),
      family,
      mode,
      isDark: mode === 'dark',
      toggle,
      setMode,
      setFamily,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [family, mode],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  return useContext(ThemeCtx);
}

/** The common case: screens/components only need the active palette, not the
 *  toggle machinery — this is what every migrated `constants/theme` color
 *  import becomes. */
export function useThemeColors(): ThemeColors {
  return useContext(ThemeCtx).colors;
}
