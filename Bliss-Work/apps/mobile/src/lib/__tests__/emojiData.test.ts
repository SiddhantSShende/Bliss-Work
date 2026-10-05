import { EMOJI_CATEGORIES } from '../emojiData';

describe('emojiData', () => {
  it('ships the full set across the eight standard categories', () => {
    expect(EMOJI_CATEGORIES.map((c) => c.key)).toEqual([
      'smileys_people', 'animals_nature', 'food_drink', 'activities', 'travel_places', 'objects', 'symbols', 'flags',
    ]);
    const total = EMOJI_CATEGORIES.reduce((n, c) => n + c.items.length, 0);
    expect(total).toBeGreaterThan(1500);
  });

  it('has searchable keywords for every emoji and no duplicates', () => {
    const seen = new Set<string>();
    for (const c of EMOJI_CATEGORIES) {
      for (const [emoji, words] of c.items) {
        expect(emoji.length).toBeGreaterThan(0);
        expect(words.length).toBeGreaterThan(0);
        expect(seen.has(emoji)).toBe(false);
        seen.add(emoji);
      }
    }
  });

  it('finds well-known emoji by name', () => {
    const all = EMOJI_CATEGORIES.flatMap((c) => c.items);
    expect(all.some(([e, w]) => e === '😀' && w.includes('grinning'))).toBe(true);
    expect(all.some(([e, w]) => e === '👍' && w.includes('thumbs'))).toBe(true);
  });
});
