import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useRuntime } from "../lib/runtime";
import type { ChannelMembers } from "../lib/sentTaskFilter";

/**
 * Member ids of the given channels, fetched only for those (the filter ticks a handful
 * of channels, never the whole list). Same route the task form's "assign to channel"
 * expands on the server. Loading and failed channels are told apart in `members`
 * (see `ChannelMembers`); `retry` re-requests one channel's members.
 */
export function useChannelMemberIds(channelIds: Iterable<string>): {
  members: ChannelMembers;
  retry: (channelId: string) => void;
} {
  const { api } = useRuntime();
  const ids = [...channelIds];
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["channelMemberIds", id],
      queryFn: () => api.channelMembers(id),
      retry: false,
    })),
  });
  // `results` is a new array every render; the data refs are what change.
  const key = results.map((r) => `${r.status}${r.isFetching}${r.dataUpdatedAt}`).join(",") + ids.join(",");
  const members = useMemo(() => {
    const out = new Map<string, readonly string[] | null>();
    results.forEach((r, i) => {
      if (r.data) out.set(ids[i]!, r.data);
      // A retry in flight reads as loading again, so the error line goes away while it runs.
      else if (r.isError && !r.isFetching) out.set(ids[i]!, null);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `key`, see above
  }, [key]);
  const retry = (channelId: string) => void results[ids.indexOf(channelId)]?.refetch();
  return { members, retry };
}
