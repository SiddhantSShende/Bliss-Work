/**
 * BlissWork's visual tokens. The 6 selectable accent-family palettes
 * (light + dark each) live in `./theme/themes.ts`, ported by hand from
 * `packages/ui/src/theme.css` — CSS custom properties don't exist in RN, so
 * that's a deliberate one-time port rather than a shared import.
 */
/** Every palette shares this shape — declared explicitly (rather than
 *  `typeof someRealPalette`) so each field is typed as plain `string`, not
 *  narrowed to one palette's own literal hex values; without this, a
 *  DIFFERENT family/mode's palette (different hex strings at every key)
 *  would fail to satisfy a type inferred from just one example object. */
export interface ThemeColors {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  muted: string;
  fg: string;
  accent: string;
  accentStrong: string;
  accentFg: string;
  accentSoft: string;
  brandFrom: string;
  brandTo: string;
  success: string;
  danger: string;
  warning: string;
  unread: string;
}

/** The default family's (Blue + Purple) light/dark palettes — used only as
 *  the fixed fallback for contexts that can't react to the user's real
 *  selection: ThemeProvider's initial context value (before AsyncStorage
 *  resolves) and ErrorBoundary's fixed light palette (a class component
 *  mounted outside ThemeProvider — see that file's own doc comment). Every
 *  themed screen reads the user's actual family/mode via `useThemeColors()`
 *  instead — sourced from `./theme/themes.ts`, the single table holding all
 *  6 families, rather than duplicated here. */
import { DEFAULT_FAMILY, paletteFor } from '../theme/themes';
export const lightColors: ThemeColors = paletteFor(DEFAULT_FAMILY, false);
export const darkColors: ThemeColors = paletteFor(DEFAULT_FAMILY, true);

/** `rounded-2xl` is the dominant corner radius across cards/panels/buttons
 *  throughout the web app (Tailwind's `2xl` = 16px) — the one radius token
 *  worth having a name for; smaller/larger radii are sized inline per
 *  component the same way the web app does with `rounded-lg`/`rounded-full`. */
export const radius = {
  card: 16,
  pill: 999,
} as const;

/** Three elevation steps, mirroring theme.css's --shadow-soft/-card/-widget.
 *  RN's shadow* props are iOS-only; elevation is Android's equivalent — both
 *  are set so a single style object works on both platforms. */
export const shadows = {
  soft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

/** Inter, bundled as an asset and linked per-platform (see
 *  react-native.config.js) — the web app's own font-family declaration,
 *  rather than falling back to each OS's system font. */
export const fontFamily = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

export const theme = { colors: lightColors, radius, shadows, spacing, fontFamily };
export type Theme = typeof theme;
