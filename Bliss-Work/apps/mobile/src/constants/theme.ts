/**
 * BlissWork's visual tokens. The six selectable themes (light + dark each —
 * twelve palettes) live in `./theme/themes.ts`.
 */
/** Every palette shares this shape — declared explicitly (rather than
 *  `typeof someRealPalette`) so each field is typed as plain `string`, not
 *  narrowed to one palette's own literal hex values; without this, a
 *  DIFFERENT family/mode's palette (different hex strings at every key)
 *  would fail to satisfy a type inferred from just one example object. */
export interface ThemeColors {
  /** Screen background. TRANSPARENT in every theme: the atmospheric background
   *  (`ThemeBackground`) is painted once, behind the whole app, and glass reads
   *  it through the screens. Use `bgSolid` where something genuinely needs an opaque fill. */
  bg: string;
  /** The opaque base colour of the theme (status/nav bars, wash behind a full-screen overlay). */
  bgSolid: string;
  /** Second stop of the background gradient (backgroundSecondary). */
  bgSecondary: string;
  /** Glass card fill — translucent, drawn over a blurred backdrop. */
  surface: string;
  /** Inner/raised glass: chips, inset rows, pressed rows. */
  surface2: string;
  /** Same fill as `surface` (the glass token by its glass name). */
  surfaceGlass: string;
  /** Denser glass for things that must stay legible: menus, popovers, bubbles. */
  surfaceStrong: string;
  border: string;
  /** The bright specular edge of a glass panel. */
  borderHighlight: string;
  /** Primary text (the `text` token). */
  fg: string;
  /** Secondary text. */
  textSecondary: string;
  /** Muted text (the `textMuted` token). */
  muted: string;
  accent: string;
  accentStrong: string;
  accentFg: string;
  accentSoft: string;
  /** The theme's second brand colour. */
  accentSecondary: string;
  /** Icon tint. */
  icon: string;
  /** Selected/active fill. */
  selected: string;
  /** Text-input fill. */
  input: string;
  /** Popup/modal panel fill (denser than a card, so text stays sharp). */
  modal: string;
  /** Floating tab-bar fill. */
  navigation: string;
  /** Drop-shadow colour. */
  shadow: string;
  /** Soft outer glow around glass panels. */
  glow: string;
  /** 0..1 — how much of a glass panel is its own fill (documentation + reflection scaling). */
  glassOpacity: number;
  /** 1..100 — backdrop blur strength for real-blur panels. */
  blurIntensity: number;
  /** 0..1 — strength of the water-glass reflection sheen. */
  reflectionOpacity: number;
  brandFrom: string;
  brandTo: string;
  success: string;
  danger: string;
  warning: string;
  unread: string;
}

import { DEFAULT_FAMILY, DEFAULT_MODE, paletteFor } from '../theme/themes';
/** The default theme's palette — the fixed fallback for contexts that can't react to the user's
 *  selection: ThemeProvider's initial value (before AsyncStorage resolves) and ErrorBoundary (a class
 *  component mounted outside ThemeProvider). Every themed screen reads `useThemeColors()` instead. */
export const lightColors: ThemeColors = paletteFor(DEFAULT_FAMILY, DEFAULT_MODE);

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
