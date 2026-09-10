import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';
import type { ChannelMessageDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { qk } from './queryKeys';

/** Group channels the caller belongs to — Home's "Channels" card, and the
 *  lighter-tier list/thread view described in the plan (mirrors Chats
 *  closely since `channels()`/`channelMessages()`/`sendChannelMessage()`
 *  parallel `conversations()`/`messages()`/`sendMessage()` almost exactly). */
export function useChannels() {
  const { api } = useRuntime();
  return useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
}

export function useChannelMessages(channelId: string | undefined) {
  const { api } = useRuntime();
  const query = useInfiniteQuery({
    queryKey: qk.channelMessages(channelId ?? ''),
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      api.channelMessages(channelId!, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage: ChannelMessageDTO[]) =>
      lastPage.length > 0 ? lastPage[0]!.seq : undefined,
    enabled: Boolean(channelId),
  });
  const messages = query.data ? [...query.data.pages].reverse().flatMap((p) => p) : [];
  return { ...query, messages };
}

/** Optimistic send for a channel — same temp-id/reconcile/rollback shape as
 *  `useSendMessage`, against `sendChannelMessage` instead of `reply`. Kept as
 *  its own hook rather than a generic "send" abstracting over both: the DTOs
 *  differ (no `status` field on `ChannelMessageDTO`) and the two call sites
 *  are simple enough that forcing one shared function over both would need
 *  more parameters than it saves lines — see the coding guide's own
 *  "don't over-abstract two similar-looking things" guidance. */
export function useSendChannelMessage(channelId: string) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const qc = useQueryClient();
  const queryKey = qk.channelMessages(channelId);

  return useMutation({
    mutationKey: queryKey,
    mutationFn: (body: string) => api.sendChannelMessage(channelId, body),
    onMutate: async (body: string) => {
      await qc.cancelQueries({ queryKey });
      const tempId = `temp:${uuid()}`;
      const optimistic: ChannelMessageDTO = {
        id: tempId,
        channelId,
        seq: Number.MAX_SAFE_INTEGER,
        senderId: me.id,
        senderUsername: me.username,
        senderDisplayName: me.displayName,
        body,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData(
        queryKey,
        (data: { pages: ChannelMessageDTO[][]; pageParams: unknown[] } | undefined) => {
          if (!data) return { pages: [[optimistic]], pageParams: [undefined] };
          const pages = [...data.pages];
          pages[0] = [...(pages[0] ?? []), optimistic];
          return { ...data, pages };
        },
      );
      return { tempId };
    },
    onSuccess: (res, _body, ctx) => {
      qc.setQueryData(
        queryKey,
        (data: { pages: ChannelMessageDTO[][]; pageParams: unknown[] } | undefined) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page) =>
              page.map((m) => (m.id === ctx?.tempId ? { ...m, id: res.messageId, seq: res.seq } : m)),
            ),
          };
        },
      );
      void qc.invalidateQueries({ queryKey: qk.channels });
    },
    onError: (_err, _body, ctx) => {
      qc.setQueryData(
        queryKey,
        (data: { pages: ChannelMessageDTO[][]; pageParams: unknown[] } | undefined) => {
          if (!data) return data;
          return { ...data, pages: data.pages.map((page) => page.filter((m) => m.id !== ctx?.tempId)) };
        },
      );
    },
  });
}
