import { useMutation, useQueryClient } from '@tanstack/react-query';
import { v4 as uuid } from 'uuid';
import type { MessageDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { qk } from './queryKeys';

/**
 * Optimistic send for one DM conversation: append a `temp:`-id row the
 * instant Send is pressed, reconcile it against the server's real id/seq on
 * success, drop it on failure.
 *
 * Intentionally a mobile-local twin of `useOptimisticSend` (packages/app/src/
 * lib/useOptimisticSend.ts) rather than an import of it — that hook's
 * `onError` unconditionally calls `sonner`'s `toast.error(...)`, a
 * React-DOM toast library with no React Native equivalent, so importing it
 * as-is would break the mobile bundle. The state machine (temp id → optimistic
 * append → reconcile → rollback) is the same; only the failure surface
 * differs (mutation `isError` state, rendered inline by the screen, matching
 * how HomeScreen already surfaces errors rather than a toast).
 */
interface SendMessageInput {
  body: string;
  /** Set when composing from a message's "Reply" action. */
  replyToId?: string;
}

export function useSendMessage(conversationId: string) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const qc = useQueryClient();
  const queryKey = qk.messages(conversationId);

  return useMutation({
    mutationKey: queryKey,
    mutationFn: (input: string | SendMessageInput) => {
      const { body, replyToId } = typeof input === 'string' ? { body: input, replyToId: undefined } : input;
      return api.reply(conversationId, body, undefined, replyToId);
    },
    onMutate: async (input: string | SendMessageInput) => {
      const body = typeof input === 'string' ? input : input.body;
      await qc.cancelQueries({ queryKey });
      const tempId = `temp:${uuid()}`;
      const optimistic: MessageDTO = {
        id: tempId,
        conversationId,
        seq: Number.MAX_SAFE_INTEGER,
        senderId: me.id,
        body,
        createdAt: new Date().toISOString(),
        status: 'PENDING',
        replyToId: typeof input === 'string' ? undefined : input.replyToId,
      };
      qc.setQueryData(queryKey, (data: { pages: MessageDTO[][]; pageParams: unknown[] } | undefined) => {
        if (!data) return { pages: [[optimistic]], pageParams: [undefined] };
        const pages = [...data.pages];
        pages[0] = [...(pages[0] ?? []), optimistic];
        return { ...data, pages };
      });
      return { tempId };
    },
    onSuccess: (res, _body, ctx) => {
      qc.setQueryData(queryKey, (data: { pages: MessageDTO[][]; pageParams: unknown[] } | undefined) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((page) =>
            page.map((m) =>
              m.id === ctx?.tempId ? { ...m, id: res.messageId, seq: res.seq, status: 'SENT' as const } : m,
            ),
          ),
        };
      });
      // Refresh the Chats list preview (lastMessage/lastMessageAt) for peerId's row.
      void qc.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: (_err, _body, ctx) => {
      qc.setQueryData(queryKey, (data: { pages: MessageDTO[][]; pageParams: unknown[] } | undefined) => {
        if (!data) return data;
        return { ...data, pages: data.pages.map((page) => page.filter((m) => m.id !== ctx?.tempId)) };
      });
    },
  });
}
