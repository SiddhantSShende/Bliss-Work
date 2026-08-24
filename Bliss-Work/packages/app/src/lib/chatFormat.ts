/** Formatting + grouping helpers for the chat thread. */

/** A run of a message body: either literal text or a URL found inside it. */
export interface MessageSegment {
  type: "text" | "link";
  value: string;
}

/** http(s) only, on purpose — a scheme this app never wants clickable
 *  (javascript:, data:, …) simply never matches, so there is no need to
 *  allowlist/denylist schemes separately. Stops at whitespace, angle
 *  brackets and quotes: those are exactly the characters that would let a
 *  matched URL run into surrounding punctuation or (if this were ever
 *  rendered as markup instead of a text child) break out of an attribute —
 *  excluding them from the match keeps a URL a URL. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Trailing characters that read as sentence punctuation rather than part of
 *  the address — "join here: https://x/y?z=1." must not pull the period into
 *  the link. A trailing ")" is kept when the URL itself opened at least as
 *  many "(" as it closes, so a parenthetical URL (Wikipedia-style) is not
 *  truncated mid-address. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url.charAt(end - 1);
    if (ch === ")") {
      const opens = (url.slice(0, end).match(/\(/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\)/g) ?? []).length;
      if (closes <= opens) break;
      end--;
      continue;
    }
    if (".,;:!?'\"]}".includes(ch)) {
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Split a message body into text/link segments, in order.
 *
 * Pure and React-free on purpose: the renderer maps `text` segments to plain
 * text children and `link` segments to an anchor's `href` AND text child —
 * never to markup, never through `dangerouslySetInnerHTML`. A segment's
 * `value` is always rendered as a text node, so there is no HTML/script
 * injection surface here regardless of what a message contains: the URL
 * character class above already excludes the characters that could matter
 * (`<`, `>`, quotes), and even if it did not, React escapes text children.
 */
export function linkifyMessage(body: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimTrailingPunctuation(match[0]);
    if (!url) continue;
    if (start > lastIndex) segments.push({ type: "text", value: body.slice(lastIndex, start) });
    segments.push({ type: "link", value: url });
    lastIndex = start + url.length;
  }
  if (lastIndex < body.length) segments.push({ type: "text", value: body.slice(lastIndex) });
  return segments;
}

/** HH:MM for a message timestamp. */
export function clock(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Today" / "Yesterday" / "12 Jun" (+ year when not the current year). */
export function dayLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export interface ChatRow<T> {
  msg: T;
  /** Present when this message starts a new calendar day. */
  day?: string;
  /** True when this continues the previous sender's recent run (collapse name/avatar). */
  grouped: boolean;
}

function withinWindow(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) < 5 * 60 * 1000;
}

/** Annotate messages with day-separator + sender-grouping flags. */
export function groupMessages<T extends { senderId: string; at?: string }>(messages: T[]): ChatRow<T>[] {
  const rows: ChatRow<T>[] = [];
  messages.forEach((m, i) => {
    const prev = i > 0 ? messages[i - 1] : undefined;
    const newDay = !prev || dayLabel(prev.at) !== dayLabel(m.at);
    const grouped = !!prev && !newDay && prev.senderId === m.senderId && withinWindow(prev.at, m.at);
    rows.push({ msg: m, day: newDay ? dayLabel(m.at) : undefined, grouped });
  });
  return rows;
}

/** Short relative-time label for inbox rows: 2m / 3h / Yesterday / 12 Jun. */
export function relative(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return dayLabel(iso);
}
