import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** The Chats list — real `ConversationDTO[]` from messaging-svc, refetched on
 *  a live WS event by `useWsBridge` rather than polled. */
export function useConversations() {
  const { api } = useRuntime();
  return useQuery({
    queryKey: qk.conversations,
    queryFn: () => api.conversations(),
  });
}
