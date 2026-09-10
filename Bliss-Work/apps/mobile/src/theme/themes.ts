import type { ThemeColors } from '../constants/theme';

/**
 * The 6 selectable accent families, ported by hand from
 * `packages/ui/src/theme.css` (the web app's single source of truth) — every
 * hex value below is copied straight from that file's `:root`/`.dark` (Blue,
 * no extra class) and `.bluePurple`/`.rose`/`.purple`/`.teal`/`.lime` blocks,
 * light and dark, not invented. CSS custom properties don't exist in RN, so
 * this is a deliberate one-time port rather than a shared import — keep it in
 * sync BY HAND if theme.css's values change.
 *
 * `--color-success/-danger/-warning/-unread` are semantic and NOT
 * family-specific in theme.css either (same value regardless of accent), so
 * they're not repeated per family here — see SEMANTIC_LIGHT/SEMANTIC_DARK.
 */
export type ThemeFamily = 'bluePurple' | 'purple' | 'rose' | 'blue' | 'teal' | 'lime';

const SEMANTIC_LIGHT = { success: '#16a34a', danger: '#dc2626', warning: '#d97706', unread: '#2563eb' };
const SEMANTIC_DARK = { success: '#44ca89', danger: '#fc5855', warning: '#f7b83d', unread: '#3b82f6' };

interface FamilyPalette {
  light: ThemeColors;
  dark: ThemeColors;
}

const PALETTES: Record<ThemeFamily, FamilyPalette> = {
  // BlissWork's DEFAULT theme (`.bluePurple` in theme.css) — a genuine blend
  // of the standalone Blue and Purple families, not an alias of either.
  bluePurple: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#71717a',
      fg: '#18181b',
      accent: '#6366f1',
      accentStrong: '#4f46e5',
      accentFg: '#ffffff',
      accentSoft: '#eef2ff',
      brandFrom: '#3b82f6',
      brandTo: '#a855f7',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#0a0a1f',
      surface: '#14132a',
      surface2: '#1c1a38',
      border: '#2e2a5c',
      muted: '#a1a1aa',
      fg: '#f8fafc',
      accent: '#818cf8',
      accentStrong: '#a5b4fc',
      accentFg: '#0a0a1f',
      accentSoft: '#312e81',
      brandFrom: '#60a5fa',
      brandTo: '#c084fc',
      ...SEMANTIC_DARK,
    },
  },
  purple: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#71717a',
      fg: '#18181b',
      accent: '#7c3aed',
      accentStrong: '#6d28d9',
      accentFg: '#ffffff',
      accentSoft: '#f5f3ff',
      brandFrom: '#c084fc',
      brandTo: '#7c3aed',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#0d0717',
      surface: '#181024',
      surface2: '#21172f',
      border: '#3b245a',
      muted: '#a1a1aa',
      fg: '#fafafa',
      accent: '#a855f7',
      accentStrong: '#c084fc',
      accentFg: '#0d0717',
      accentSoft: '#3b0764',
      brandFrom: '#c084fc',
      brandTo: '#a855f7',
      ...SEMANTIC_DARK,
    },
  },
  rose: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#71717a',
      fg: '#18181b',
      accent: '#e11d48',
      accentStrong: '#be123c',
      accentFg: '#ffffff',
      accentSoft: '#fff1f2',
      brandFrom: '#fb7185',
      brandTo: '#e11d48',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#09090b',
      surface: '#18181b',
      surface2: '#221419',
      border: '#3f1d2b',
      muted: '#a1a1aa',
      fg: '#fafafa',
      accent: '#f43f5e',
      accentStrong: '#fb7185',
      accentFg: '#09090b',
      accentSoft: '#4c0519',
      brandFrom: '#fb7185',
      brandTo: '#f43f5e',
      ...SEMANTIC_DARK,
    },
  },
  // "Blue" is the web app's original palette — the bare :root/.dark block
  // with no extra CSS class of its own.
  blue: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#6b7280',
      fg: '#111827',
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      accentFg: '#ffffff',
      accentSoft: '#eff6ff',
      brandFrom: '#60a5fa',
      brandTo: '#2563eb',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#020817',
      surface: '#0f172a',
      surface2: '#16213a',
      border: '#1e3a5f',
      muted: '#94a3b8',
      fg: '#f8fafc',
      accent: '#3b82f6',
      accentStrong: '#60a5fa',
      accentFg: '#020817',
      accentSoft: '#172554',
      brandFrom: '#60a5fa',
      brandTo: '#3b82f6',
      ...SEMANTIC_DARK,
    },
  },
  teal: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#64748b',
      fg: '#18181b',
      accent: '#06b6d4',
      accentStrong: '#0891b2',
      accentFg: '#ffffff',
      accentSoft: '#ecfeff',
      brandFrom: '#22d3ee',
      brandTo: '#06b6d4',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#031316',
      surface: '#0b2024',
      surface2: '#0f2a2f',
      border: '#164e63',
      muted: '#94a3b8',
      fg: '#ecfeff',
      accent: '#06b6d4',
      accentStrong: '#22d3ee',
      accentFg: '#031316',
      accentSoft: '#083344',
      brandFrom: '#22d3ee',
      brandTo: '#06b6d4',
      ...SEMANTIC_DARK,
    },
  },
  lime: {
    light: {
      bg: '#fafafa',
      surface: '#ffffff',
      surface2: '#f4f4f5',
      border: '#e4e4e7',
      muted: '#71717a',
      fg: '#18181b',
      accent: '#65a30d',
      accentStrong: '#4d7c0f',
      accentFg: '#ffffff',
      accentSoft: '#f7fee7',
      brandFrom: '#a3e635',
      brandTo: '#65a30d',
      ...SEMANTIC_LIGHT,
    },
    dark: {
      bg: '#080f04',
      surface: '#101f13',
      surface2: '#16281a',
      border: '#2c4a1f',
      muted: '#a1a1aa',
      fg: '#f7fee7',
      accent: '#84cc16',
      accentStrong: '#a3e635',
      accentFg: '#080f04',
      accentSoft: '#1a2e05',
      brandFrom: '#bef264',
      brandTo: '#65a30d',
      ...SEMANTIC_DARK,
    },
  },
};

/** Menu order — mirrors packages/ui/src/theme/themes.ts's FAMILIES order
 *  exactly, so mobile's theme picker lists families the same way web's
 *  Settings → Theme menu does. */
export const FAMILIES: readonly { id: ThemeFamily; name: string }[] = [
  { id: 'purple', name: 'Purple' },
  { id: 'rose', name: 'Red / Rose' },
  { id: 'blue', name: 'Blue' },
  { id: 'teal', name: 'Cyan / Teal' },
  { id: 'lime', name: 'Lime' },
  { id: 'bluePurple', name: 'Blue + Purple' },
];

/** BlissWork's default theme, per themes.css's own DEFAULT_THEME — used for
 *  a brand-new install, a new device, or a first login with nothing saved
 *  yet. Never the OS's dark-mode preference (see ThemeProvider.tsx). */
export const DEFAULT_FAMILY: ThemeFamily = 'bluePurple';

export function isThemeFamily(value: string): value is ThemeFamily {
  return value in PALETTES;
}

export function familyName(id: ThemeFamily): string {
  return FAMILIES.find((f) => f.id === id)?.name ?? FAMILIES[0]!.name;
}

export function paletteFor(family: ThemeFamily, dark: boolean): ThemeColors {
  return dark ? PALETTES[family].dark : PALETTES[family].light;
}
