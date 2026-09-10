/** Compact relative time ("now"/"5m"/"3h"/"2d") for list-row timestamps —
 *  Chats, Channels, Mail, and Notifications all need the same short form, so
 *  it's centralized here rather than copied per screen. No date library is
 *  installed in this app; this covers what a list row needs without adding
 *  one. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
