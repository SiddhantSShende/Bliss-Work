import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemeColors } from '../constants/theme';
import {
  DEFAULT_FAMILY,
  DEFAULT_MODE,
  encodeTheme,
  paletteFor,
  resolveStoredTheme,
  type ThemeFamily,
  type ThemeMode,
  type ThemeSelection,
} from './themes';

const STORAGE_KEY = 'tb-theme-id';
/** Read by an older release to remember Light/Dark separately. Mode now lives in the one
 *  theme value, so this key is removed the first time this version runs. */
const LEGACY_MODE_KEY = 'tb-theme-mode';

interface ThemeContextValue {
  colors: ThemeColors;
  family: ThemeFamily;
  mode: ThemeMode;
  /** Whether the active variant is dark. */
  isDark: boolean;
  /** Pick a theme; the current Light/Dark mode is kept. */
  setFamily: (family: ThemeFamily) => void;
  /** Switch Light/Dark; the current theme is kept. */
  setMode: (mode: ThemeMode) => void;
}

const DEFAULT_VALUE: ThemeContextValue = {
  colors: paletteFor(DEFAULT_FAMILY, DEFAULT_MODE),
  family: DEFAULT_FAMILY,
  mode: DEFAULT_MODE,
  isDark: DEFAULT_MODE === 'dark',
  setFamily: () => {},
  setMode: () => {},
};

const ThemeCtx = createContext<ThemeContextValue>(DEFAULT_VALUE);

/**
 * The one place mobile decides the active theme and hands out its palette.
 * Every screen/component reads `useThemeColors()` and re-renders when the
 * theme changes, so picking a theme or flipping Light/Dark restyles the whole
 * running app at once — no logout, no reload.
 *
 * The active theme is `{ family, mode }`, saved as ONE string in one storage
 * key (`"dominant:dark"`). The saved choice is restored before anything is
 * drawn (children wait for the single AsyncStorage read), so a returning user
 * never sees the default theme flash before theirs. An older stored value is
 * carried over to the equivalent variant (see `resolveStoredTheme`) and
 * rewritten, so an outdated value never stays active.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<ThemeSelection>({ family: DEFAULT_FAMILY, mode: DEFAULT_MODE });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { migrated, ...stored } = resolveStoredTheme(await AsyncStorage.getItem(STORAGE_KEY));
        if (alive) setSelection(stored);
        if (migrated) await AsyncStorage.setItem(STORAGE_KEY, encodeTheme(stored));
        await AsyncStorage.removeItem(LEGACY_MODE_KEY);
      } catch {
        // Storage unavailable: the default theme applies for this session.
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const apply = (next: ThemeSelection) => {
      setSelection(next);
      AsyncStorage.setItem(STORAGE_KEY, encodeTheme(next)).catch(() => {
        // The choice still applies for this session.
      });
    };
    return {
      colors: paletteFor(selection.family, selection.mode),
      family: selection.family,
      mode: selection.mode,
      isDark: selection.mode === 'dark',
      setFamily: (family) => apply({ ...selection, family }),
      setMode: (mode) => apply({ ...selection, mode }),
    };
  }, [selection]);

  return (
    <ThemeCtx.Provider value={value}>
      {loaded ? children : <View style={{ flex: 1, backgroundColor: DEFAULT_VALUE.colors.bgSolid }} />}
    </ThemeCtx.Provider>
  );
}

export function useAppTheme(): ThemeContextValue {
  return useContext(ThemeCtx);
}

/** The common case: screens/components only need the active palette. */
export function useThemeColors(): ThemeColors {
  return useContext(ThemeCtx).colors;
}
