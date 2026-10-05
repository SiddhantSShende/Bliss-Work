import { parseColor } from '../../lib/color';
import {
  DEFAULT_FAMILY,
  DEFAULT_MODE,
  FAMILIES,
  MODES,
  artFor,
  encodeTheme,
  familyName,
  isThemeFamily,
  paletteFor,
  resolveStoredTheme,
  type ThemeFamily,
  type ThemeMode,
} from '../themes';

const IDS = FAMILIES.map((f) => f.id);
const MODE_IDS = MODES.map((m) => m.id);
/** Every one of the twelve variants. */
const VARIANTS: [ThemeFamily, ThemeMode][] = IDS.flatMap((id) => MODE_IDS.map((m): [ThemeFamily, ThemeMode] => [id, m]));

describe('the theme list', () => {
  it('is exactly the six themes, in order', () => {
    expect(FAMILIES.map((f) => f.name)).toEqual(['Dominant', 'Linen', 'Merino', 'White Smoke', 'Moss Velvet', 'Iris Wave']);
  });
  it('offers Light and Dark, and every theme has both: 6 x 2 = 12 variants', () => {
    expect(MODES.map((m) => m.name)).toEqual(['Light', 'Dark']);
    expect(VARIANTS).toHaveLength(12);
    for (const [id, mode] of VARIANTS) {
      expect(paletteFor(id, mode)).toBeDefined();
      expect(artFor(id, mode)).toBeDefined();
    }
  });
  it('has none of the retired themes anywhere in its names or ids', () => {
    const retired = /amethyst|crimson|periwinkle|turquoise|acid green|bluepurple|midnight|rosewood|^purple$|^rose$|^teal$|^lime$|^blue$/i;
    for (const f of FAMILIES) {
      expect(f.name).not.toMatch(retired);
      expect(f.id).not.toMatch(retired);
    }
  });
  it('defaults to Dominant Dark', () => {
    expect(DEFAULT_FAMILY).toBe('dominant');
    expect(DEFAULT_MODE).toBe('dark');
    expect(familyName(DEFAULT_FAMILY)).toBe('Dominant');
  });
});

describe('what is in storage', () => {
  it('keeps every valid family:mode value', () => {
    for (const [family, mode] of VARIANTS) {
      expect(resolveStoredTheme(encodeTheme({ family, mode }))).toEqual({ family, mode, migrated: false });
    }
  });
  it('carries a family-only value over to the mode that family always had, and says to rewrite it', () => {
    expect(resolveStoredTheme('dominant')).toEqual({ family: 'dominant', mode: 'dark', migrated: true });
    expect(resolveStoredTheme('mossVelvet')).toEqual({ family: 'mossVelvet', mode: 'dark', migrated: true });
    expect(resolveStoredTheme('linen')).toEqual({ family: 'linen', mode: 'light', migrated: true });
    expect(resolveStoredTheme('merino')).toEqual({ family: 'merino', mode: 'light', migrated: true });
    expect(resolveStoredTheme('whiteSmoke')).toEqual({ family: 'whiteSmoke', mode: 'light', migrated: true });
  });
  it('continues the short-lived Midnight and Rosewood as dark Merino and dark White Smoke', () => {
    expect(resolveStoredTheme('midnight')).toEqual({ family: 'merino', mode: 'dark', migrated: true });
    expect(resolveStoredTheme('rosewood')).toEqual({ family: 'whiteSmoke', mode: 'dark', migrated: true });
  });
  it('sends every older retired theme to the default and says to rewrite it', () => {
    for (const old of ['purple', 'rose', 'blue', 'teal', 'lime', 'bluePurple', 'purple-dark', 'rose-dark', 'bluePurple-dark', 'lime-dark']) {
      expect(isThemeFamily(old)).toBe(false);
      expect(resolveStoredTheme(old)).toEqual({ family: 'dominant', mode: 'dark', migrated: true });
    }
  });
  it('treats garbage like a retired theme, and nothing stored as a fresh install', () => {
    for (const bad of ['constructor', '', 'dominant:', ':dark', 'dominant:dim', 'dominant:dark:x', 'toString']) {
      expect(resolveStoredTheme(bad)).toEqual({ family: 'dominant', mode: 'dark', migrated: true });
    }
    expect(resolveStoredTheme(null)).toEqual({ family: 'dominant', mode: 'dark', migrated: false });
  });
});

describe('every variant is a complete design', () => {
  const keys = (id: ThemeFamily, mode: ThemeMode) => Object.keys(paletteFor(id, mode)).sort();
  it('defines the same set of tokens', () => {
    for (const [id, mode] of VARIANTS) expect(keys(id, mode)).toEqual(keys('dominant', 'dark'));
  });
  it('exposes the shared glass tokens', () => {
    const p = paletteFor('dominant', 'dark');
    for (const k of ['bgSecondary', 'surfaceGlass', 'surfaceStrong', 'borderHighlight', 'textSecondary', 'accentSecondary', 'icon', 'selected', 'input', 'modal', 'navigation', 'shadow', 'glow', 'glassOpacity', 'blurIntensity', 'reflectionOpacity']) {
      expect(p).toHaveProperty(k);
    }
  });
  it('is glass in every variant: translucent cards, real blur, a visible edge', () => {
    for (const [id, mode] of VARIANTS) {
      const p = paletteFor(id, mode);
      expect(p.bg).toBe('transparent');
      expect(parseColor(p.surface)![3]).toBeLessThan(0.7);
      expect(p.blurIntensity).toBeGreaterThanOrEqual(35);
      expect(parseColor(p.border)![3]).toBeGreaterThanOrEqual(0.18);
    }
  });
});

// ── legibility ────────────────────────────────────────────────────────────────
type RGB = [number, number, number];
const over = (top: [number, number, number, number], under: RGB): RGB => [0, 1, 2].map((i) => Math.round(top[i]! * top[3] + under[i]! * (1 - top[3]))) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const rgb = (c: string): RGB => parseColor(c)!.slice(0, 3) as RGB;

describe('text stays readable on the glass (WCAG)', () => {
  for (const [id, mode] of VARIANTS) {
    const name = `${id} ${mode}`;
    const p = paletteFor(id, mode);
    // Worst case behind a card: each of the atmosphere's gradient stops and its brightest/most saturated light pool.
    const art = artFor(id, mode);
    const backdrops: RGB[] = [...art.gradient.map(rgb), ...art.blobs.map((b) => over([...rgb(b.color), b.opacity] as [number, number, number, number], rgb(art.gradient[1])))];
    for (const [i, back] of backdrops.entries()) {
      const card = over(parseColor(p.surface)!, back);
      it(`${name}: primary text on a card over backdrop ${i} is >= 4.5:1`, () => {
        expect(contrast(rgb(p.fg), card)).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: secondary and muted text on a card over backdrop ${i} are >= 4.5:1 / 4.0:1`, () => {
        expect(contrast(rgb(p.textSecondary), card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgb(p.muted), card)).toBeGreaterThanOrEqual(4.0);
      });
    }
    it(`${name}: text on the denser glass (menus, popups, bars) is >= 4.5:1`, () => {
      for (const back of backdrops) {
        for (const fill of [p.surfaceStrong, p.modal, p.navigation]) {
          const panel = over(parseColor(fill)!, back);
          expect(contrast(rgb(p.fg), panel)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(`${name}: button label on the accent is >= 4.5:1 and the accent is visible on the page (>= 3:1)`, () => {
      expect(contrast(rgb(p.accentFg), rgb(p.accent))).toBeGreaterThanOrEqual(4.5);
      for (const back of backdrops) expect(contrast(rgb(p.accent), over(parseColor(p.surface)!, back))).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: icons are visible on the glass (>= 3:1)`, () => {
      for (const back of backdrops) expect(contrast(rgb(p.icon), over(parseColor(p.surface)!, back))).toBeGreaterThanOrEqual(3);
    });
  }
});

// ── light is light, dark is dark ──────────────────────────────────────────────
describe('light variants are light and dark variants are dark', () => {
  for (const [id, mode] of VARIANTS) {
    it(`${id} ${mode}: the whole atmosphere and base colour sit on the right side`, () => {
      const p = paletteFor(id, mode);
      const art = artFor(id, mode);
      const stops = [p.bgSolid, ...art.gradient].map((c) => lum(rgb(c)));
      if (mode === 'dark') {
        for (const l of stops) expect(l).toBeLessThan(0.05);
        // Light pools stay soft so the background never turns bright.
        for (const r of art.ribbons) expect(r.opacity).toBeLessThanOrEqual(0.16);
        expect(lum(rgb(p.fg))).toBeGreaterThan(0.8);
      } else {
        for (const l of stops) expect(l).toBeGreaterThan(0.55);
        expect(lum(rgb(p.fg))).toBeLessThan(0.1);
      }
    });
  }
});

// ── identity: each variant is recognisably its theme ──────────────────────────
describe('each theme keeps its identity colours', () => {
  const has = (id: ThemeFamily, mode: ThemeMode, hex: string) => {
    const p = paletteFor(id, mode);
    const art = artFor(id, mode);
    const all = [...Object.values(p), ...art.gradient, ...art.blobs.map((b) => b.color), ...art.ribbons.flatMap((r) => [r.from, r.to])];
    return all.some((c) => typeof c === 'string' && c.toLowerCase() === hex.toLowerCase());
  };
  it('Dominant: #210B2C core, #BC96E6 secondary, #FFD166 accent (readable accent on dark; deep gold on light)', () => {
    for (const mode of MODE_IDS) {
      expect(has('dominant', mode, '#BC96E6')).toBe(true);
      expect(has('dominant', mode, '#FFD166')).toBe(true);
    }
    expect(has('dominant', 'dark', '#210B2C')).toBe(true);
    expect(paletteFor('dominant', 'dark').accent).toBe('#FFD166');
    expect(paletteFor('dominant', 'dark').icon).toBe('#FFD166');
  });
  it('Linen: #AB92BF secondary and #655A7C accent (light uses #655A7C directly)', () => {
    for (const mode of MODE_IDS) {
      expect(has('linen', mode, '#AB92BF')).toBe(true);
      expect(has('linen', mode, '#655A7C')).toBe(true);
    }
    expect(paletteFor('linen', 'light').bgSolid).toBe('#FDF1E2');
  });
  it('Merino: #84B3CE secondary and #16587B accent', () => {
    for (const mode of MODE_IDS) {
      expect(has('merino', mode, '#84B3CE')).toBe(true);
      expect(has('merino', mode, '#16587B')).toBe(true);
    }
  });
  it('White Smoke: #F7F4F3 base and #5B2333 burgundy', () => {
    expect(paletteFor('whiteSmoke', 'light').bgSolid).toBe('#F7F4F3');
    for (const mode of MODE_IDS) expect(has('whiteSmoke', mode, '#5B2333')).toBe(true);
  });
  it('Moss Velvet: #385144 forest green and a warm-white #F8F5F2', () => {
    for (const mode of MODE_IDS) {
      expect(has('mossVelvet', mode, '#385144')).toBe(true);
      expect(has('mossVelvet', mode, '#F8F5F2')).toBe(true);
    }
  });
  it('Iris Wave: blue + purple in both modes', () => {
    const hueOf = ([r, g, b]: RGB) => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const d = max - Math.min(R, G, B);
      if (d === 0) return 0;
      const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const mode of MODE_IDS) {
      const p = paletteFor('irisWave', mode);
      for (const c of [p.accent, p.icon]) {
        const h = hueOf(rgb(c));
        expect(h).toBeGreaterThan(220);
        expect(h).toBeLessThan(285);
      }
    }
  });
});
