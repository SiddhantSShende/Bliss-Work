import type { ThemeColors } from '../constants/theme';

/**
 * BlissWork mobile's six glass themes, each in LIGHT and DARK — twelve variants.
 * Every variant is a complete, self-contained design (its own atmosphere —
 * gradient + soft light shapes — glass fills, borders, accent, text and icon
 * colours), not a recolour of another. The dark variants are designed, not
 * inverted: each keeps its theme's identity colours (the hexes below) and lets
 * them glow on a deep base.
 *
 *   Dominant     #210B2C / #BC96E6 / #FFD166   dark purple, lavender, warm gold
 *   Linen        #FDF1E2 / #AB92BF / #655A7C   cream, lavender, muted violet
 *   Merino       #F5EEDD / #84B3CE / #16587B   cream, cool blue, deep blue
 *   White Smoke  #F7F4F3 / #5B2333             smoke white, burgundy / rose
 *   Moss Velvet  #F8F5F2 / #385144             warm white, forest green
 *   Iris Wave    light blue + purple (light) / indigo-navy + violet (dark)
 *
 * Where a brand colour is too pale (or too dark) to be read as TEXT or as a
 * button fill on its variant's glass, `accent` is a deeper (light) or lighter
 * (dark) tint of the same hue — the identity hex is kept in `accentSecondary`,
 * `brandFrom/To` and the atmosphere. The legibility tests (themes.test.ts)
 * hold every variant to WCAG contrast.
 *
 * Glass fills are translucent rgba strings on purpose — they only look right
 * over the blurred atmosphere, and `components/glass/GlassSurface.tsx` supplies
 * the blur, the reflection and the edge highlight on top of them.
 *
 * Which of the twelve is active is `{ family, mode }`, stored as ONE string in
 * ThemeProvider's existing storage key (`"dominant:dark"`).
 *
 * (The web app's own theme list lives in packages/ui and is deliberately not
 * shared — mobile has its own, per the product design.)
 */
export type ThemeFamily = 'dominant' | 'linen' | 'merino' | 'whiteSmoke' | 'mossVelvet' | 'irisWave';
export type ThemeMode = 'light' | 'dark';

const SEMANTIC_LIGHT = { success: '#15803d', danger: '#b91c1c', warning: '#b45309', unread: '#2563eb' };
const SEMANTIC_DARK = { success: '#4ade80', danger: '#fb7185', warning: '#fbbf24', unread: '#60a5fa' };

/** The atmosphere painted behind the whole app (see `components/glass/ThemeBackground.tsx`). */
export interface ThemeArt {
  /** Diagonal base gradient, top-left to bottom-right. */
  gradient: readonly [string, string, string];
  /** Soft light pools. x/y/r are fractions of the screen WIDTH/HEIGHT/WIDTH. */
  blobs: readonly { x: number; y: number; r: number; color: string; opacity: number }[];
  /** Faint flowing ribbons, as SVG paths in a 0..100 x 0..200 box. */
  ribbons: readonly { d: string; from: string; to: string; opacity: number }[];
}

interface Variant {
  colors: ThemeColors;
  art: ThemeArt;
}

interface ThemeDef {
  name: string;
  light: Variant;
  dark: Variant;
}

/** Fields every variant of a mode shares; the rest is written out per variant. */
type Own = Omit<ThemeColors, 'bg' | 'surfaceGlass' | 'success' | 'danger' | 'warning' | 'unread'>;
const light = (c: Own): ThemeColors => ({ bg: 'transparent', surfaceGlass: c.surface, ...SEMANTIC_LIGHT, ...c });
const dark = (c: Own): ThemeColors => ({ bg: 'transparent', surfaceGlass: c.surface, ...SEMANTIC_DARK, ...c });

// Two faint ribbons per atmosphere; the same flowing shapes, tinted per variant.
const RIBBON_A = 'M-10 40 C 30 10, 60 70, 110 30 L 110 60 C 60 100, 30 40, -10 75 Z';
const RIBBON_B = 'M-10 150 C 40 120, 70 190, 110 150 L 110 175 C 70 215, 40 150, -10 185 Z';
const ribbons = (from: string, to: string, a: number, b: number): ThemeArt['ribbons'] => [
  { d: RIBBON_A, from, to, opacity: a },
  { d: RIBBON_B, from: to, to: from, opacity: b },
];

const THEMES: Record<ThemeFamily, ThemeDef> = {
  // ── Dominant: deep purple, lavender glass, warm gold accent ────────────────
  dominant: {
    name: 'Dominant',
    // Soft lavender glass over a bright lilac atmosphere; deep-gold accent
    // (#FFD166 itself is unreadable as text on light glass).
    light: {
      colors: light({
        bgSolid: '#F1E7FA',
        bgSecondary: '#E4D3F4',
        surface: 'rgba(255, 255, 255, 0.50)',
        surface2: 'rgba(255, 255, 255, 0.68)',
        surfaceStrong: 'rgba(251, 246, 255, 0.92)',
        border: 'rgba(33, 11, 44, 0.18)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#210B2C',
        textSecondary: '#43285A',
        muted: '#68507D',
        accent: '#946000',
        accentStrong: '#7A4E00',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(255, 209, 102, 0.36)',
        accentSecondary: '#BC96E6',
        icon: '#5A2E8A',
        selected: 'rgba(188, 150, 230, 0.34)',
        input: 'rgba(255, 255, 255, 0.62)',
        modal: 'rgba(250, 245, 254, 0.95)',
        navigation: 'rgba(247, 240, 253, 0.64)',
        shadow: '#3B1A57',
        glow: 'rgba(188, 150, 230, 0.46)',
        glassOpacity: 0.5,
        blurIntensity: 55,
        reflectionOpacity: 0.5,
        brandFrom: '#FFD166',
        brandTo: '#946000',
      }),
      art: {
        gradient: ['#F8F1FD', '#EBDDF8', '#DCC6F0'],
        blobs: [
          { x: 0.9, y: 0.06, r: 0.8, color: '#BC96E6', opacity: 0.55 },
          { x: 0.04, y: 0.55, r: 0.75, color: '#FFD166', opacity: 0.26 },
          { x: 0.9, y: 0.92, r: 0.7, color: '#9B6BD8', opacity: 0.3 },
        ],
        ribbons: ribbons('#FFFFFF', '#BC96E6', 0.42, 0.36),
      },
    },
    // The premium dark glass look: near-black purple base (#210B2C) with violet
    // light pooled in the corners, violet glass cards with a lavender edge,
    // near-white text, and #FFD166 gold as the accent (active tab, buttons,
    // icons, focus) — never a fill for whole cards.
    dark: {
      colors: dark({
        bgSolid: '#14061F',
        bgSecondary: '#210B2C',
        surface: 'rgba(150, 100, 225, 0.11)',
        surface2: 'rgba(150, 100, 225, 0.19)',
        surfaceStrong: 'rgba(32, 13, 50, 0.90)',
        border: 'rgba(170, 125, 250, 0.36)',
        borderHighlight: 'rgba(222, 200, 255, 0.34)',
        fg: '#FAF7FF',
        textSecondary: '#DCD0F3',
        muted: '#B4A6D0',
        accent: '#FFD166',
        accentStrong: '#FFE29A',
        accentFg: '#210B2C',
        accentSoft: 'rgba(255, 209, 102, 0.18)',
        accentSecondary: '#BC96E6',
        icon: '#FFD166',
        selected: 'rgba(255, 209, 102, 0.16)',
        input: 'rgba(255, 255, 255, 0.07)',
        modal: 'rgba(24, 9, 38, 0.95)',
        navigation: 'rgba(30, 12, 46, 0.68)',
        shadow: '#000000',
        glow: 'rgba(150, 100, 255, 0.46)',
        glassOpacity: 0.11,
        blurIntensity: 40,
        reflectionOpacity: 0.11,
        brandFrom: '#FFD166',
        brandTo: '#BC96E6',
      }),
      art: {
        gradient: ['#2A0F3D', '#210B2C', '#0E0415'],
        blobs: [
          { x: 0.95, y: 0.06, r: 0.8, color: '#7C3AED', opacity: 0.34 },
          { x: 0.02, y: 0.62, r: 0.85, color: '#5B21B6', opacity: 0.24 },
          { x: 0.9, y: 0.97, r: 0.6, color: '#BC96E6', opacity: 0.18 },
        ],
        ribbons: ribbons('#BC96E6', '#7C3AED', 0.13, 0.1),
      },
    },
  },

  // ── Linen: warm cream / warm charcoal, lavender glass ──────────────────────
  linen: {
    name: 'Linen',
    light: {
      colors: light({
        bgSolid: '#FDF1E2',
        bgSecondary: '#F3E2EE',
        surface: 'rgba(255, 255, 255, 0.52)',
        surface2: 'rgba(255, 255, 255, 0.70)',
        surfaceStrong: 'rgba(255, 252, 247, 0.92)',
        border: 'rgba(101, 90, 124, 0.20)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#2E2640',
        textSecondary: '#4C4262',
        muted: '#6A5F80',
        accent: '#655A7C',
        accentStrong: '#4E4463',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(171, 146, 191, 0.26)',
        accentSecondary: '#AB92BF',
        icon: '#655A7C',
        selected: 'rgba(171, 146, 191, 0.30)',
        input: 'rgba(255, 255, 255, 0.62)',
        modal: 'rgba(255, 250, 243, 0.95)',
        navigation: 'rgba(255, 250, 243, 0.62)',
        shadow: '#6B5B8A',
        glow: 'rgba(171, 146, 191, 0.38)',
        glassOpacity: 0.52,
        blurIntensity: 55,
        reflectionOpacity: 0.5,
        brandFrom: '#AB92BF',
        brandTo: '#655A7C',
      }),
      art: {
        gradient: ['#FFF6EA', '#FDF1E2', '#F4E3EE'],
        blobs: [
          { x: 0.88, y: 0.06, r: 0.8, color: '#C8B2DC', opacity: 0.55 },
          { x: 0.04, y: 0.55, r: 0.75, color: '#F6D9B8', opacity: 0.6 },
          { x: 0.9, y: 0.92, r: 0.7, color: '#AB92BF', opacity: 0.32 },
        ],
        ribbons: [
          { d: 'M-10 60 C 30 30, 60 90, 110 50 L 110 80 C 60 120, 30 60, -10 95 Z', from: '#FFFFFF', to: '#C8B2DC', opacity: 0.42 },
          { d: 'M-10 160 C 40 130, 70 200, 110 160 L 110 185 C 70 225, 40 160, -10 195 Z', from: '#E8D5F2', to: '#FFFFFF', opacity: 0.36 },
        ],
      },
    },
    // Warm charcoal-plum base, cream/lavender glass, muted violet accent
    // (lightened from #655A7C, which is too dim to read on dark glass).
    dark: {
      colors: dark({
        bgSolid: '#17110F',
        bgSecondary: '#261C21',
        surface: 'rgba(235, 215, 195, 0.09)',
        surface2: 'rgba(235, 215, 195, 0.16)',
        surfaceStrong: 'rgba(34, 26, 30, 0.90)',
        border: 'rgba(205, 185, 230, 0.30)',
        borderHighlight: 'rgba(255, 240, 225, 0.28)',
        fg: '#FBF3E8',
        textSecondary: '#E4D8CC',
        muted: '#BBADA6',
        accent: '#BBA8DC',
        accentStrong: '#D5C8EC',
        accentFg: '#1F1829',
        accentSoft: 'rgba(171, 146, 191, 0.22)',
        accentSecondary: '#AB92BF',
        icon: '#CBBBE6',
        selected: 'rgba(171, 146, 191, 0.26)',
        input: 'rgba(255, 245, 235, 0.07)',
        modal: 'rgba(30, 22, 26, 0.95)',
        navigation: 'rgba(38, 28, 33, 0.68)',
        shadow: '#000000',
        glow: 'rgba(171, 146, 191, 0.36)',
        glassOpacity: 0.09,
        blurIntensity: 42,
        reflectionOpacity: 0.12,
        brandFrom: '#CBBBE6',
        brandTo: '#655A7C',
      }),
      art: {
        gradient: ['#2B2025', '#1A1316', '#0E0A0C'],
        blobs: [
          { x: 0.92, y: 0.07, r: 0.8, color: '#655A7C', opacity: 0.36 },
          { x: 0.03, y: 0.62, r: 0.85, color: '#8A6A5C', opacity: 0.22 },
          { x: 0.9, y: 0.96, r: 0.6, color: '#AB92BF', opacity: 0.14 },
        ],
        ribbons: ribbons('#CBBBE6', '#655A7C', 0.11, 0.09),
      },
    },
  },

  // ── Merino: warm cream / deep navy, blue water-glass ───────────────────────
  merino: {
    name: 'Merino',
    light: {
      colors: light({
        bgSolid: '#E7F2F8',
        bgSecondary: '#D2E6F2',
        surface: 'rgba(255, 255, 255, 0.46)',
        surface2: 'rgba(255, 255, 255, 0.64)',
        surfaceStrong: 'rgba(247, 252, 255, 0.92)',
        border: 'rgba(22, 88, 123, 0.20)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#0C2D42',
        textSecondary: '#24516B',
        muted: '#44687E',
        accent: '#16587B',
        accentStrong: '#0F4766',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(132, 179, 206, 0.30)',
        accentSecondary: '#84B3CE',
        icon: '#16587B',
        selected: 'rgba(132, 179, 206, 0.34)',
        input: 'rgba(255, 255, 255, 0.60)',
        modal: 'rgba(244, 251, 255, 0.95)',
        navigation: 'rgba(244, 251, 255, 0.60)',
        shadow: '#16587B',
        glow: 'rgba(120, 190, 230, 0.40)',
        glassOpacity: 0.46,
        blurIntensity: 55,
        reflectionOpacity: 0.55,
        brandFrom: '#84B3CE',
        brandTo: '#16587B',
      }),
      art: {
        gradient: ['#F1F8FC', '#E4F0F8', '#CFE4F1'],
        blobs: [
          { x: 0.85, y: 0.05, r: 0.85, color: '#9CCBE6', opacity: 0.55 },
          { x: 0.02, y: 0.5, r: 0.8, color: '#C9E8F5', opacity: 0.7 },
          { x: 0.92, y: 0.9, r: 0.75, color: '#84B3CE', opacity: 0.4 },
        ],
        ribbons: [
          { d: 'M-10 50 C 30 20, 65 85, 110 40 L 110 72 C 65 115, 30 55, -10 88 Z', from: '#FFFFFF', to: '#84B3CE', opacity: 0.4 },
          { d: 'M-10 150 C 35 125, 75 190, 110 148 L 110 176 C 75 214, 35 150, -10 186 Z', from: '#BFE3F5', to: '#FFFFFF', opacity: 0.4 },
        ],
      },
    },
    // Deep navy / blue-black, blue glass, cyan-blue highlights; the accent is a
    // lighter tint of #16587B (which is too dark to read on navy).
    dark: {
      colors: dark({
        bgSolid: '#06121C',
        bgSecondary: '#0B2234',
        surface: 'rgba(132, 179, 206, 0.11)',
        surface2: 'rgba(132, 179, 206, 0.19)',
        surfaceStrong: 'rgba(8, 26, 42, 0.90)',
        border: 'rgba(120, 190, 232, 0.32)',
        borderHighlight: 'rgba(205, 232, 250, 0.30)',
        fg: '#F2F8FD',
        textSecondary: '#CFE0EE',
        muted: '#9DB7C9',
        accent: '#5FB3E6',
        accentStrong: '#9ACFF0',
        accentFg: '#04131F',
        accentSoft: 'rgba(95, 179, 230, 0.20)',
        accentSecondary: '#84B3CE',
        icon: '#7DC2EC',
        selected: 'rgba(95, 179, 230, 0.24)',
        input: 'rgba(255, 255, 255, 0.07)',
        modal: 'rgba(7, 22, 36, 0.95)',
        navigation: 'rgba(9, 28, 45, 0.68)',
        shadow: '#000000',
        glow: 'rgba(80, 170, 230, 0.44)',
        glassOpacity: 0.11,
        blurIntensity: 40,
        reflectionOpacity: 0.11,
        brandFrom: '#84B3CE',
        brandTo: '#16587B',
      }),
      art: {
        gradient: ['#0C2A40', '#07182A', '#030C16'],
        blobs: [
          { x: 0.95, y: 0.06, r: 0.8, color: '#16587B', opacity: 0.4 },
          { x: 0.02, y: 0.62, r: 0.85, color: '#0B3C5C', opacity: 0.3 },
          { x: 0.9, y: 0.97, r: 0.6, color: '#84B3CE', opacity: 0.16 },
        ],
        ribbons: ribbons('#84B3CE', '#16587B', 0.13, 0.1),
      },
    },
  },

  // ── White Smoke: smoke white / dark wine, rose + burgundy ──────────────────
  whiteSmoke: {
    name: 'White Smoke',
    light: {
      colors: light({
        bgSolid: '#F7F4F3',
        bgSecondary: '#F3E3E8',
        surface: 'rgba(255, 255, 255, 0.55)',
        surface2: 'rgba(255, 255, 255, 0.72)',
        surfaceStrong: 'rgba(255, 251, 251, 0.93)',
        border: 'rgba(91, 35, 51, 0.18)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#3A1620',
        textSecondary: '#5B2333',
        muted: '#7B5560',
        accent: '#5B2333',
        accentStrong: '#451A27',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(214, 150, 168, 0.26)',
        accentSecondary: '#D697A8',
        icon: '#5B2333',
        selected: 'rgba(214, 150, 168, 0.32)',
        input: 'rgba(255, 255, 255, 0.66)',
        modal: 'rgba(255, 250, 250, 0.95)',
        navigation: 'rgba(255, 250, 250, 0.62)',
        shadow: '#7A3447',
        glow: 'rgba(230, 160, 180, 0.40)',
        glassOpacity: 0.55,
        blurIntensity: 55,
        reflectionOpacity: 0.5,
        brandFrom: '#D697A8',
        brandTo: '#5B2333',
      }),
      art: {
        gradient: ['#FBF8F7', '#F7F1F1', '#F1E0E6'],
        blobs: [
          { x: 0.9, y: 0.06, r: 0.8, color: '#F1BFCD', opacity: 0.55 },
          { x: 0.03, y: 0.55, r: 0.75, color: '#FFFFFF', opacity: 0.8 },
          { x: 0.92, y: 0.92, r: 0.7, color: '#E2A3B6', opacity: 0.35 },
        ],
        ribbons: [
          { d: 'M-10 55 C 30 25, 62 88, 110 45 L 110 76 C 62 118, 30 58, -10 92 Z', from: '#FFFFFF', to: '#EBB4C4', opacity: 0.45 },
          { d: 'M-10 155 C 38 128, 72 195, 110 152 L 110 180 C 72 218, 38 155, -10 190 Z', from: '#F6D3DD', to: '#FFFFFF', opacity: 0.4 },
        ],
      },
    },
    // Dark wine / charcoal, rose glass with burgundy-leaning borders, soft pink
    // highlights (#5B2333 itself stays as the deep pool in the atmosphere).
    dark: {
      colors: dark({
        bgSolid: '#17090F',
        bgSecondary: '#2A1019',
        surface: 'rgba(240, 150, 175, 0.10)',
        surface2: 'rgba(240, 150, 175, 0.18)',
        surfaceStrong: 'rgba(38, 12, 22, 0.90)',
        border: 'rgba(232, 128, 158, 0.32)',
        borderHighlight: 'rgba(255, 220, 230, 0.30)',
        fg: '#FFF7F8',
        textSecondary: '#F1D6DC',
        muted: '#C9A6B0',
        accent: '#F2A0B6',
        accentStrong: '#F8C4D1',
        accentFg: '#2A0A14',
        accentSoft: 'rgba(242, 160, 182, 0.20)',
        accentSecondary: '#B04A66',
        icon: '#F4A9BD',
        selected: 'rgba(242, 160, 182, 0.22)',
        input: 'rgba(255, 255, 255, 0.07)',
        modal: 'rgba(32, 9, 18, 0.95)',
        navigation: 'rgba(42, 12, 24, 0.68)',
        shadow: '#000000',
        glow: 'rgba(235, 120, 150, 0.42)',
        glassOpacity: 0.1,
        blurIntensity: 40,
        reflectionOpacity: 0.11,
        brandFrom: '#F4A9BD',
        brandTo: '#5B2333',
      }),
      art: {
        gradient: ['#2E1019', '#1A0A10', '#0E0508'],
        blobs: [
          { x: 0.95, y: 0.06, r: 0.8, color: '#7A1F3A', opacity: 0.4 },
          { x: 0.02, y: 0.62, r: 0.85, color: '#5B2333', opacity: 0.4 },
          { x: 0.9, y: 0.97, r: 0.6, color: '#F2A0B6', opacity: 0.14 },
        ],
        ribbons: ribbons('#F4A9BD', '#7A1F3A', 0.13, 0.1),
      },
    },
  },

  // ── Moss Velvet: warm white / forest green-black ───────────────────────────
  mossVelvet: {
    name: 'Moss Velvet',
    // Warm off-white (#F8F5F2) with muted forest-green glass; the accent is a
    // deep green derived from #385144 / the mint highlight.
    light: {
      colors: light({
        bgSolid: '#EEF2EC',
        bgSecondary: '#DDE8DE',
        surface: 'rgba(255, 255, 255, 0.52)',
        surface2: 'rgba(255, 255, 255, 0.70)',
        surfaceStrong: 'rgba(250, 252, 249, 0.92)',
        border: 'rgba(56, 81, 68, 0.22)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#16261E',
        textSecondary: '#2E4A3C',
        muted: '#4F6A5C',
        accent: '#2F6B4A',
        accentStrong: '#245238',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(95, 160, 125, 0.24)',
        accentSecondary: '#385144',
        icon: '#385144',
        selected: 'rgba(95, 160, 125, 0.28)',
        input: 'rgba(255, 255, 255, 0.62)',
        modal: 'rgba(248, 252, 248, 0.95)',
        navigation: 'rgba(248, 250, 246, 0.62)',
        shadow: '#2F5240',
        glow: 'rgba(95, 160, 125, 0.36)',
        glassOpacity: 0.52,
        blurIntensity: 55,
        reflectionOpacity: 0.5,
        brandFrom: '#B7E4C7',
        brandTo: '#385144',
      }),
      art: {
        gradient: ['#F8F5F2', '#EDF1EA', '#DCE7DD'],
        blobs: [
          { x: 0.9, y: 0.06, r: 0.8, color: '#A9CDB4', opacity: 0.5 },
          { x: 0.03, y: 0.55, r: 0.75, color: '#FFFFFF', opacity: 0.8 },
          { x: 0.92, y: 0.92, r: 0.7, color: '#385144', opacity: 0.18 },
        ],
        ribbons: ribbons('#FFFFFF', '#A9CDB4', 0.45, 0.4),
      },
    },
    dark: {
      colors: dark({
        bgSolid: '#16241D',
        bgSecondary: '#22372D',
        surface: 'rgba(160, 205, 176, 0.11)',
        surface2: 'rgba(160, 205, 176, 0.19)',
        surfaceStrong: 'rgba(28, 46, 37, 0.88)',
        border: 'rgba(160, 205, 176, 0.28)',
        borderHighlight: 'rgba(255, 255, 255, 0.30)',
        fg: '#F8F5F2',
        textSecondary: '#D5E2D9',
        muted: '#BBD0C2',
        accent: '#B7E4C7',
        accentStrong: '#D2F0DC',
        accentFg: '#0F1B15',
        accentSoft: 'rgba(183, 228, 199, 0.18)',
        accentSecondary: '#F8F5F2',
        icon: '#B7E4C7',
        selected: 'rgba(183, 228, 199, 0.20)',
        input: 'rgba(255, 255, 255, 0.07)',
        modal: 'rgba(24, 40, 32, 0.95)',
        navigation: 'rgba(30, 48, 39, 0.62)',
        shadow: '#000000',
        glow: 'rgba(110, 200, 140, 0.36)',
        glassOpacity: 0.11,
        blurIntensity: 45,
        reflectionOpacity: 0.15,
        brandFrom: '#B7E4C7',
        brandTo: '#4F8A68',
      }),
      art: {
        gradient: ['#2A4034', '#1B2C23', '#101C16'],
        blobs: [
          { x: 0.9, y: 0.07, r: 0.85, color: '#3F7A58', opacity: 0.45 },
          { x: 0.03, y: 0.7, r: 0.85, color: '#385144', opacity: 0.7 },
          { x: 0.95, y: 0.95, r: 0.55, color: '#B7E4C7', opacity: 0.08 },
        ],
        ribbons: [
          { d: 'M-10 45 C 32 15, 62 78, 110 38 L 110 68 C 62 108, 32 48, -10 82 Z', from: '#B7E4C7', to: '#4F8A68', opacity: 0.16 },
          { d: 'M-10 152 C 38 126, 72 192, 110 150 L 110 178 C 72 216, 38 152, -10 188 Z', from: '#4F8A68', to: '#B7E4C7', opacity: 0.13 },
        ],
      },
    },
  },

  // ── Iris Wave: light blue + purple / deep indigo-navy with violet + cyan ───
  irisWave: {
    name: 'Iris Wave',
    light: {
      colors: light({
        bgSolid: '#EDEFFB',
        bgSecondary: '#DEE2F7',
        surface: 'rgba(255, 255, 255, 0.52)',
        surface2: 'rgba(255, 255, 255, 0.70)',
        surfaceStrong: 'rgba(250, 250, 255, 0.92)',
        border: 'rgba(79, 70, 200, 0.20)',
        borderHighlight: 'rgba(255, 255, 255, 0.95)',
        fg: '#1B1B45',
        textSecondary: '#383A74',
        muted: '#5A5D8C',
        accent: '#4F46C8',
        accentStrong: '#3B34A8',
        accentFg: '#FFFFFF',
        accentSoft: 'rgba(124, 111, 224, 0.22)',
        accentSecondary: '#7FA6F5',
        icon: '#4F46C8',
        selected: 'rgba(124, 111, 224, 0.28)',
        input: 'rgba(255, 255, 255, 0.62)',
        modal: 'rgba(250, 251, 255, 0.95)',
        navigation: 'rgba(248, 249, 255, 0.62)',
        shadow: '#4A4590',
        glow: 'rgba(124, 130, 240, 0.40)',
        glassOpacity: 0.52,
        blurIntensity: 55,
        reflectionOpacity: 0.52,
        brandFrom: '#7FA6F5',
        brandTo: '#6A4FD6',
      }),
      art: {
        gradient: ['#F4F6FE', '#E7EAFA', '#D9DDF6'],
        blobs: [
          { x: 0.88, y: 0.06, r: 0.82, color: '#8FA8F0', opacity: 0.5 },
          { x: 0.03, y: 0.55, r: 0.78, color: '#C7AEF2', opacity: 0.5 },
          { x: 0.9, y: 0.92, r: 0.72, color: '#7E8CF0', opacity: 0.3 },
        ],
        ribbons: ribbons('#FFFFFF', '#A7B4F2', 0.42, 0.38),
      },
    },
    dark: {
      colors: dark({
        bgSolid: '#0A0C24',
        bgSecondary: '#141A3F',
        surface: 'rgba(125, 130, 245, 0.11)',
        surface2: 'rgba(125, 130, 245, 0.19)',
        surfaceStrong: 'rgba(16, 18, 52, 0.90)',
        border: 'rgba(135, 145, 255, 0.34)',
        borderHighlight: 'rgba(210, 215, 255, 0.32)',
        fg: '#F4F5FF',
        textSecondary: '#D3D6F5',
        muted: '#A5AAD2',
        accent: '#9C90FF',
        accentStrong: '#C2BAFF',
        accentFg: '#10113A',
        accentSoft: 'rgba(156, 144, 255, 0.20)',
        accentSecondary: '#5CC8F5',
        icon: '#AEA4FF',
        selected: 'rgba(156, 144, 255, 0.24)',
        input: 'rgba(255, 255, 255, 0.07)',
        modal: 'rgba(12, 14, 42, 0.95)',
        navigation: 'rgba(16, 20, 54, 0.68)',
        shadow: '#000000',
        glow: 'rgba(120, 110, 255, 0.46)',
        glassOpacity: 0.11,
        blurIntensity: 40,
        reflectionOpacity: 0.11,
        brandFrom: '#7DD3FC',
        brandTo: '#6D4AE8',
      }),
      art: {
        gradient: ['#161B4A', '#0C0F2E', '#05061A'],
        blobs: [
          { x: 0.95, y: 0.06, r: 0.8, color: '#4338CA', opacity: 0.36 },
          { x: 0.02, y: 0.62, r: 0.85, color: '#1E40AF', opacity: 0.3 },
          { x: 0.9, y: 0.97, r: 0.6, color: '#7C3AED', opacity: 0.24 },
        ],
        ribbons: ribbons('#8E9BFF', '#4338CA', 0.13, 0.1),
      },
    },
  },
};

/** Selector order. */
export const FAMILIES: readonly { id: ThemeFamily; name: string }[] = (
  ['dominant', 'linen', 'merino', 'whiteSmoke', 'mossVelvet', 'irisWave'] as const
).map((id) => ({ id, name: THEMES[id].name }));

export const MODES: readonly { id: ThemeMode; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
];

/** The default: a brand-new install, a new device, or a stored value that is no longer valid. */
export const DEFAULT_FAMILY: ThemeFamily = 'dominant';
export const DEFAULT_MODE: ThemeMode = 'dark';

export function isThemeFamily(value: unknown): value is ThemeFamily {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEMES, value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

export function familyName(id: ThemeFamily): string {
  return THEMES[id].name;
}

export function paletteFor(family: ThemeFamily, mode: ThemeMode): ThemeColors {
  return THEMES[family][mode].colors;
}

export function artFor(family: ThemeFamily, mode: ThemeMode): ThemeArt {
  return THEMES[family][mode].art;
}

export interface ThemeSelection {
  family: ThemeFamily;
  mode: ThemeMode;
}

/** What is written to storage: one string, e.g. `"dominant:dark"`. */
export function encodeTheme(sel: ThemeSelection): string {
  return `${sel.family}:${sel.mode}`;
}

/**
 * Releases before light/dark variants stored just a family id, and every family
 * was then fixed light or dark — so each maps to the mode it always had (the
 * user sees exactly what they had). Midnight and Rosewood were short-lived dark
 * themes; they continue as the dark Merino and White Smoke.
 */
const LEGACY: Record<string, ThemeSelection> = {
  dominant: { family: 'dominant', mode: 'dark' },
  linen: { family: 'linen', mode: 'light' },
  merino: { family: 'merino', mode: 'light' },
  whiteSmoke: { family: 'whiteSmoke', mode: 'light' },
  mossVelvet: { family: 'mossVelvet', mode: 'dark' },
  midnight: { family: 'merino', mode: 'dark' },
  rosewood: { family: 'whiteSmoke', mode: 'dark' },
};

/**
 * Turns whatever is in storage into a valid theme. A current `family:mode`
 * value is kept; a legacy family id is carried over (see LEGACY); anything
 * else — the older retired themes ("purple", "rose-dark", "bluePurple"…),
 * garbage, null — resolves to the default. `migrated` says the stored value
 * should be rewritten so an outdated value never stays on disk.
 */
export function resolveStoredTheme(raw: string | null): ThemeSelection & { migrated: boolean } {
  if (raw !== null) {
    const [family, mode, ...rest] = raw.split(':');
    if (rest.length === 0 && isThemeFamily(family) && isThemeMode(mode)) return { family, mode, migrated: false };
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY, raw) ? LEGACY[raw] : undefined;
    if (legacy) return { ...legacy, migrated: true };
  }
  return { family: DEFAULT_FAMILY, mode: DEFAULT_MODE, migrated: raw !== null };
}
