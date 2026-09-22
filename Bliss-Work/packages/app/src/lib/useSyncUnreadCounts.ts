import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "./queryKeys";

/** The full lists the rail's unread totals are derived from. */
const COUNTED_LISTS = [qk.conversations, qk.channels, qk.inboxPeers];

/** Coalesces the burst a single action produces (a mark-read refetches or patches several lists). */
const SETTLE_MS = 150;

const isCountedList = (key: readonly unknown[]) =>
  COUNTED_LISTS.some((list) => list.length === key.length && list.every((part, i) => part === key[i]));

/**
 * Keeps the rail badges (`qk.unreadCounts`) in step with local reads.
 *
 * The totals come from their own endpoint, so nothing tied them to the lists they
 * summarise: reading a conversation, a channel or a mail thread invalidated or
 * patched that list, but the badge kept its old number until the next WebSocket
 * event happened to refresh it. Rather than remember to invalidate the badges at
 * every one of those call sites, watch the lists themselves — any invalidation or
 * write to one of them (including `setQueryData` patches) refreshes the totals.
 */
export function useSyncUnreadCounts(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !isCountedList(event.query.queryKey)) return;
      const { type } = event.action;
      if (type !== "invalidate" && type !== "success") return;
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: qk.unreadCounts }), SETTLE_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [qc]);
}
