/**
 * Shared shape between the room's local-only artifacts — notes
 * (lib/callNotes), chat (lib/callChat), and the local recording
 * (lib/localRecording): a filename that says which meeting, a browser-local
 * copy that survives a reload, and — for notes/chat — the dedupe-by-id merge
 * both use to fold in what arrives over the wire. Neither notes nor chat has
 * a server copy (see either file's own doc comment for why), so both need
 * this same set of plumbing independently; the recording reuses only the
 * filename half, since it has no synced entries to merge.
 */

/** A filename that says which meeting, and sorts: `<title>-<kind>-YYYY-MM-DD.<ext>`. */
export function meetingArtifactFilename(
  title: string,
  kind: string,
  at = new Date(),
  ext = "txt",
): string {
  const slug =
    (title || "meeting")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "meeting";
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
  return `${slug}-${kind}-${day}.${ext}`;
}

/**
 * Fold `incoming` into `held`, deduped by id and sorted by `at` then `id` to
 * break ties, capped at `cap` keeping the newest.
 *
 * The identical merge shape both lib/callNotes and lib/callChat need: each
 * client may receive the same entry more than once (a sync-on-join, a
 * reconnect), so what arrives has to collapse rather than duplicate, and it
 * has to collapse the same way regardless of arrival order. Validating the
 * shape of `incoming` (untrusted, from another participant's client) is the
 * caller's job — see isChatEntry/isNoteEntry — because that check is
 * entry-type-specific; by the time entries reach here they are trusted to
 * have `id` and `at`.
 *
 * Returns `held` itself, unchanged, when nothing new was added — so a sync
 * that told us nothing new cannot cause a re-render, or scroll a panel
 * somebody is reading.
 */
export function mergeById<T extends { id: string; at: number }>(
  held: readonly T[],
  incoming: readonly T[],
  cap: number,
): T[] {
  const byId = new Map(held.map((e) => [e.id, e]));
  let changed = false;
  for (const entry of incoming) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    changed = true;
  }
  if (!changed) return held as T[];
  const all = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // Keep the NEWEST when the cap bites: the end of a meeting is the half
  // worth having, and dropping from the front keeps the list stable for
  // everyone.
  return all.length > cap ? all.slice(all.length - cap) : all;
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
