/**
 * BlissWork's visual tokens, ported from the single shared source of truth
 * (`packages/ui/src/theme.css`'s `@theme`/`:root`/`.default` blocks) into a
 * plain TS object React Native can consume — CSS custom properties don't
 * exist in RN, so this is a deliberate one-time port rather than a shared
 * import. Only the light, "default" (purple) family is ported for now,
 * matching every other brand-new-mobile-screen decision in this phase: the
 * other three selectable accent families and dark mode are a fast-follow,
 * not a v1 requirement.
 *
 * Keep this in sync BY HAND if theme.css's `.default`/`:root` values change —
 * there is no build step that could do this automatically across a CSS file
 * and a native app.
 */
export const colors = {
  bg: '#fafafa',
  surface: '#ffffff',
  surface2: '#f4f4f5',
  border: '#e4e4e7',
  muted: '#6b7280',
  fg: '#111827',

  accent: '#7c3aed',
  accentStrong: '#6d28d9',
  accentFg: '#ffffff',
  accentSoft: '#f5f3ff',
  brandFrom: '#c084fc',
  brandTo: '#7c3aed',

  // Semantic colors — fixed across every accent family in the web app too,
  // so there's nothing accent-specific to track here.
  success: '#16a34a',
  danger: '#dc2626',
  warning: '#d97706',
  unread: '#2563eb',
} as const;

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

export const theme = { colors, radius, shadows, spacing, fontFamily };
export type Theme = typeof theme;
