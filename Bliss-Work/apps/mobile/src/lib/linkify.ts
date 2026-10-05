/** Splits chat text into plain and URL segments so URLs can be rendered tappable. */
export type TextSegment = { text: string; url?: string };

// http(s):// or www. up to whitespace; trailing sentence punctuation and an unbalanced ")" stay out of the link.
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

function trimTrailing(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (last && /[.,;:!?'"\]}]/.test(last)) {
      u = u.slice(0, -1);
    } else if (last === ')' && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) {
      u = u.slice(0, -1);
    } else break;
  }
  return u;
}

/** `www.x.com` has no scheme; give it one so Linking can open it. */
export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = trimTrailing(m[0]);
    if (!url) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, url: normalizeUrl(url) });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
