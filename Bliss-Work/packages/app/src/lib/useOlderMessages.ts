import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { MESSAGE_PAGE_SIZE } from "@taskboard/shared";
import { toast } from "sonner";

/** The shape both MessageDTO and ChannelMessageDTO share for paging purposes. */
interface Paged {
  id: string;
  seq: number;
}

/**
 * Back-pagination over a FLAT message cache.
 *
 * The history queries hold one page — the newest — and older pages are
 * prepended into that same flat array rather than moving to useInfiniteQuery.
 * That is deliberate, not a shortcut: the websocket bridge (queryBridge.tsx) and
 * every optimistic send in DMView/ChannelView patch this cache directly as
 * `T[]`, and a `{ pages: T[][] }` shape would have to be threaded through all of
 * them — a lot of churn in the exact code paths where a mistake silently loses
 * a message, for no user-visible gain.
 *
 * Dedupes on prepend because a message can arrive over the websocket while an
 * older page that also contains it is still in flight.
 */
export function useOlderMessages<T extends Paged>(
  key: QueryKey,
  scopeId: string,
  loaded: T[],
  fetchPage: (beforeSeq: number, limit: number) => Promise<T[]>,
  /**
   * Called with the window that was just fetched, for side data keyed to the
   * same page — reactions, in practice. Without it, back-paginated messages
   * would render with their reaction chips missing, since the reactions
   * endpoint is windowed by the same cursor.
   */
  onWindow?: (beforeSeq: number, limit: number) => void,
) {
  const qc = useQueryClient();
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Assume there IS more until a short page proves otherwise. Guessing the
  // other way would hide the control on exactly the threads that need it.
  const [hasOlder, setHasOlder] = useState(true);
  const inFlight = useRef(false);

  // These routes stay mounted across navigation — switching conversation must
  // reset the cursor state or the new thread inherits the old one's "reached
  // the beginning".
  useEffect(() => {
    setHasOlder(true);
    setLoadingOlder(false);
    inFlight.current = false;
  }, [scopeId]);

  // Not wrapped in useCallback on purpose: it closes over `loaded`, which
  // changes on every message, and a memoised version would page from a stale
  // cursor.
  const loadOlder = async () => {
    if (inFlight.current || !hasOlder || loaded.length === 0) return;
    inFlight.current = true;
    setLoadingOlder(true);
    try {
      const oldest = loaded.reduce((min, m) => Math.min(min, m.seq), Infinity);
      const older = await fetchPage(oldest, MESSAGE_PAGE_SIZE);
      // A short page means the server had nothing more to give.
      if (older.length < MESSAGE_PAGE_SIZE) setHasOlder(false);
      if (older.length > 0) {
        qc.setQueryData<T[]>(key, (prev) => {
          const held = new Set((prev ?? []).map((m) => m.id));
          return [...older.filter((m) => !held.has(m.id)), ...(prev ?? [])];
        });
        onWindow?.(oldest, MESSAGE_PAGE_SIZE);
      }
    } catch {
      toast.error("Couldn't load earlier messages");
    } finally {
      inFlight.current = false;
      setLoadingOlder(false);
    }
  };

  return { loadOlder, loadingOlder, hasOlder };
}
