import { useInfiniteQuery } from '@tanstack/react-query';
import type { MessageDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/**
 * One conversation's messages, paginated backwards via `beforeSeq` per
 * `ApiClient.messages`'s own contract ("pass the lowest seq you already
 * hold to walk backwards; a short page means you've reached the start").
 */
export function useMessages(conversationId: string | undefined) {
  const { api } = useRuntime();
  const query = useInfiniteQuery({
    queryKey: qk.messages(conversationId ?? ''),
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      api.messages(conversationId!, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage: MessageDTO[]) =>
      lastPage.length > 0 ? lastPage[0]!.seq : undefined,
    enabled: Boolean(conversationId),
  });

  // Each page is ascending by seq, but pages themselves arrive newest-first
  // (page 1 = latest, page 2 = the older page fetched via beforeSeq) — reverse
  // the PAGE order, not each page's own contents, to get one fully ascending,
  // oldest-first array a conversation screen can render (and reverse once
  // more for an inverted FlatList).
  const messages = query.data ? [...query.data.pages].reverse().flatMap((p) => p) : [];

  return { ...query, messages };
}
