/**
 * Pure cache patches for the mentions feed.
 *
 * Claim and Ignore both update the list optimistically so the row disappears
 * the instant you click, and both must be able to roll back cleanly when the
 * server says no. That logic lives here rather than inside the component
 * because `packages/app` has no DOM test environment — a pure module is the
 * only seam these rules can actually be tested through.
 *
 * Every function is non-mutating: TanStack Query compares by reference to
 * decide what to re-render, so patching a page array in place would leave the
 * UI showing stale rows.
 */
import type { MentionDTO, MentionPageDTO } from "@taskboard/shared";

/** The shape useInfiniteQuery keeps in the cache. */
export interface MentionPages {
  pages: MentionPageDTO[];
  pageParams: unknown[];
}

/**
 * Remove one mention from whichever page holds it.
 *
 * `nextCursor` is deliberately left untouched: it encodes a position in the
 * server's ordering, and rewriting it after a local removal would make the next
 * fetch skip a row.
 */
export function dropMention(data: MentionPages | undefined, id: string): MentionPages | undefined {
  if (!data) return data;
  let hit = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((m) => m.id === id)) return page;
    hit = true;
    return { ...page, items: page.items.filter((m) => m.id !== id) };
  });
  // Preserve reference identity when nothing matched, so React skips the render.
  return hit ? { ...data, pages } : data;
}

/** Mark a mention claimed in place, recording the task it became. */
export function markClaimed(
  data: MentionPages | undefined,
  id: string,
  taskId: string,
): MentionPages | undefined {
  if (!data) return data;
  let hit = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((m) => m.id === id)) return page;
    hit = true;
    return {
      ...page,
      items: page.items.map((m) =>
        m.id === id ? { ...m, state: "claimed" as const, taskId } : m,
      ),
    };
  });
  return hit ? { ...data, pages } : data;
}

/** Flatten paginated mentions for rendering. Safe on an unfetched cache. */
export function flatMentions(data: MentionPages | undefined): MentionDTO[] {
  if (!data) return [];
  return data.pages.flatMap((p) => p.items);
}

/** Count across all loaded pages — drives the "Pending" tab badge. */
export function countMentions(data: MentionPages | undefined): number {
  return flatMentions(data).length;
}
