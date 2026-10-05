import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/** Tasks fetched per request — the server's maximum page. */
const PAGE_SIZE = 100;

/**
 * The allocator's sent tasks, newest page first, loaded a page at a time.
 *
 * The key is a child of qk.sent: the realtime bridge's invalidate(qk.sent)
 * prefix-matches it, while TasksList/Search keep their own plain-array qk.sent
 * cache. The My tasks header and the board both call this, and TanStack dedupes
 * them onto one request and one cache entry.
 */
export function useMySentTasks() {
  const { api } = useRuntime();
  const sent = useInfiniteQuery({
    queryKey: [...qk.sent, "board"],
    queryFn: ({ pageParam }) => api.tasksSent({ limit: PAGE_SIZE, offset: pageParam, includeIgnored: true }),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length < PAGE_SIZE ? undefined : all.reduce((n, page) => n + page.length, 0),
  });
  const tasks = useMemo(() => sent.data?.pages.flat() ?? [], [sent.data]);
  return { sent, tasks };
}
