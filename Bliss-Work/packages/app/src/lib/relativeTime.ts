/**
 * "12m ago", "3h ago", "yesterday", "4d ago".
 *
 * Shared by the members list and the member detail pane, which both answer
 * "when was this person last here" and must not answer it differently.
 *
 * Deliberately coarse: the point is recency, not a timestamp. A caller that
 * needs the exact moment should render the ISO value in a `title` instead.
 */
export function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
