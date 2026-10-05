import { linkify, normalizeUrl } from '../linkify';

describe('linkify', () => {
  it('returns plain text untouched', () => {
    expect(linkify('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('finds a bare URL and keeps surrounding text', () => {
    expect(linkify('Check this website\nhttps://example.com')).toEqual([
      { text: 'Check this website\n' },
      { text: 'https://example.com', url: 'https://example.com' },
    ]);
  });

  it('keeps trailing sentence punctuation out of the link', () => {
    const segs = linkify('see https://example.com/a?b=1, then https://x.io.');
    expect(segs.filter((s) => s.url).map((s) => s.url)).toEqual(['https://example.com/a?b=1', 'https://x.io']);
  });

  it('handles parentheses around a URL', () => {
    const segs = linkify('(https://example.com/x)');
    expect(segs.find((s) => s.url)?.url).toBe('https://example.com/x');
    expect(segs[segs.length - 1]).toEqual({ text: ')' });
  });

  it('keeps a balanced ")" that belongs to the URL', () => {
    expect(linkify('https://en.wikipedia.org/wiki/Foo_(bar)').find((s) => s.url)?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('adds a scheme to www. links', () => {
    expect(linkify('www.example.com')[0]).toEqual({ text: 'www.example.com', url: 'https://www.example.com' });
    expect(normalizeUrl('http://a.b')).toBe('http://a.b');
  });

  it('detects several links in one message', () => {
    expect(linkify('a https://one.com b https://two.com').filter((s) => s.url)).toHaveLength(2);
  });
});
