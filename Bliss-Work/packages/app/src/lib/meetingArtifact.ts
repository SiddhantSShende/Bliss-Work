/**
 * Shared shape between the room's two local-only artifacts — notes
 * (lib/callNotes) and chat (lib/callChat): a filename that says which
 * meeting, and a browser-local copy that survives a reload. Neither has a
 * server copy (see either file's own doc comment for why), so both need this
 * same pair independently.
 */

/** A filename that says which meeting, and sorts: `<title>-<kind>-YYYY-MM-DD.txt`. */
export function meetingArtifactFilename(title: string, kind: string, at = new Date()): string {
  const slug =
    (title || "meeting")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "meeting";
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
  return `${slug}-${kind}-${day}.txt`;
}

/** This browser's copy of a list keyed by callId, so a reload mid-meeting does
 *  not lose it. Storage can be absent (private mode, a locked-down WebView) —
 *  that degrades to "lives only in this tab", never to a crash. `merge` is the
 *  caller's own validate + dedupe + cap pass (mergeNotes/mergeChat), applied
 *  against an empty starting list so a malformed or hostile stored entry
 *  cannot resurrect itself past that check. */
export function loadLocalCopy<T>(key: string, merge: (held: T[], incoming: T[]) => T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? merge([], parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalCopy<T>(key: string, items: readonly T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Quota, or no storage at all. The list is still in memory and still on the
    // wire; losing the cache is not worth interrupting a meeting for.
  }
}
