/** Formatting + grouping helpers for the chat thread. */

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
