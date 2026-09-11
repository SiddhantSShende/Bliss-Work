import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';
import type { ChannelMessageDTO, ChannelRole, ReactionDTO } from '@taskboard/shared';
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

/** The directory of open channels the caller can browse and join but hasn't
 *  yet — backs the Channels screen's "All" tab (alongside `useChannels`'
 *  "My Channels"). One page is enough for the mobile browse list; a person
 *  looking for a specific channel narrows with the search field instead of
 *  paging. */
export function useOpenChannels() {
  const { api } = useRuntime();
  return useQuery({ queryKey: qk.openChannels, queryFn: () => api.openChannels({ limit: 100 }) });
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
    mutationFn: (input: string | { body: string; replyToId?: string }) => {
      const { body, replyToId } = typeof input === 'string' ? { body: input, replyToId: undefined } : input;
      return api.sendChannelMessage(channelId, body, undefined, undefined, replyToId);
    },
    onMutate: async (input: string | { body: string; replyToId?: string }) => {
      const body = typeof input === 'string' ? input : input.body;
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
        replyToId: typeof input === 'string' ? undefined : input.replyToId,
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

/** One channel's full member+role roster (`api.channelRoster`) — used by
 *  ChannelMembersScreen and ChannelDetailScreen. */
export function useChannelRoster(channelId: string) {
  const { api } = useRuntime();
  return useQuery({
    queryKey: qk.channelRoster(channelId),
    queryFn: () => api.channelRoster(channelId),
    enabled: Boolean(channelId),
  });
}

/** Creates a channel and drops the caller straight into its roster/list
 *  cache — CreateChannelScreen's Create button. */
export function useCreateChannel() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; memberIds: string[]; isLocked?: boolean }) => api.createChannel(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useJoinChannel() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.joinChannel(channelId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useLeaveChannel() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.leaveChannel(channelId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useAddChannelMembers(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberIds: string[]) => api.addChannelMembers(channelId, memberIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelRoster(channelId) }),
  });
}

export function useKickChannelMember(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.kickChannelMember(channelId, userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelRoster(channelId) }),
  });
}

export function useSetChannelMemberRole(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ChannelRole }) =>
      api.setChannelMemberRole(channelId, userId, role),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelRoster(channelId) }),
  });
}

export function useRenameChannel() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, name }: { channelId: string; name: string }) => api.renameChannel(channelId, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

/** Channel twin of `useReactions` — same per-page-cursor fetch, same
 *  kept-off-the-message-cache reasoning. Pass `useChannelMessages`'s
 *  `data?.pageParams`. */
export function useChannelReactions(channelId: string, pageParams: (number | undefined)[]) {
  const { api } = useRuntime();
  const results = useQueries({
    queries: pageParams.map((pageParam) => ({
      queryKey: [...qk.channelReactions(channelId), pageParam ?? 'latest'],
      queryFn: () => api.channelReactions(channelId, pageParam),
      enabled: Boolean(channelId),
    })),
  });

  return useMemo(() => {
    const byMessageId = new Map<string, ReactionDTO[]>();
    for (const page of results) {
      for (const reaction of (page.data as ReactionDTO[] | undefined) ?? []) {
        const list = byMessageId.get(reaction.messageId);
        if (list) list.push(reaction);
        else byMessageId.set(reaction.messageId, [reaction]);
      }
    }
    return (messageId: string) => byMessageId.get(messageId) ?? [];
  }, [results]);
}

/** Channel twin of `useSetReaction`. */
export function useSetChannelReaction(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji, on }: { messageId: string; emoji: string; on: boolean }) =>
      api.setChannelReaction(messageId, emoji, on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelReactions(channelId) }),
  });
}

/** Pin/unpin a channel message — moderators only, server-enforced; the UI
 *  only decides whether to offer the option (see the client method's own
 *  doc). */
export function useSetChannelMessagePin(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, on }: { messageId: string; on: boolean }) => api.setChannelMessagePin(messageId, on),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
  });
}

/** "Delete for me" in a channel — hides it from the caller's own view only,
 *  any member may do this for any message (see `hideChannelMessage`'s own
 *  doc); "Delete for everyone" is the one gated to the author/moderators. */
export function useHideChannelMessage(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.hideChannelMessage(messageId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
  });
}

/** "Delete for everyone" in a channel, one message at a time from the
 *  long-press menu — the batch form (`deleteChannelMessagesForAll`) already
 *  backs multi-select delete; this reuses the same endpoint for a single id
 *  so the two entry points share one code path. */
export function useDeleteChannelMessages(channelId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageIds: string[]) => api.deleteChannelMessagesForAll(channelId, messageIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
  });
}
