import { Alert } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

/** "Delete for me" — hides one message from the caller's own view only;
 *  either party may do this for any message (see `hideMessage`'s own doc). */
export function useHideMessage(conversationId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.hideMessage(messageId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.messages(conversationId) }),
    onError: () => {
      Alert.alert("Couldn't delete message", 'Please try again.');
    },
  });
}

/** Forward one message to another DM — the single-recipient case of
 *  `forwardMessages` (packages/shared/src/api/client.ts); the mobile picker
 *  only offers people, not channels, to keep the target picker to the same
 *  shape as NewChatScreen's. */
export function useForwardMessage() {
  const { api } = useRuntime();
  return useMutation({
    mutationFn: ({ messageId, targetUserId }: { messageId: string; targetUserId: string }) =>
      api.forwardMessages({ messageIds: [messageId], targets: [{ kind: 'user', id: targetUserId }] }),
    onError: () => {
      Alert.alert("Couldn't forward message", 'Please try again.');
    },
  });
}

/** "Select Messages" → Delete, for messages the caller sent — the same
 *  `deleteMessageForAll` semantics `packages/app` already uses on web, just
 *  batched. The server is the authority on which selected ids the caller
 *  actually owns (see `deleteMessagesForAll`'s own doc); ids it skips come
 *  back in `skipped` rather than failing the whole request. */
export function useDeleteMessages(conversationId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageIds: string[]) => api.deleteMessagesForAll(conversationId, messageIds),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: qk.messages(conversationId) });
      if (result.skipped.length > 0) {
        Alert.alert('Some messages were not deleted', 'You can only delete messages you sent.');
      }
    },
    onError: () => {
      Alert.alert("Couldn't delete messages", 'Please try again.');
    },
  });
}
