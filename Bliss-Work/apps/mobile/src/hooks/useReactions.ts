import { useMemo } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { ReactionDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/**
 * Reaction tallies for a DM conversation, fetched one page at a time with
 * the SAME `beforeSeq` cursors `useMessages`'s pages were fetched with (pass
 * its `data?.pageParams`) — mirrors web's DMView.tsx, which fetches
 * `conversationReactions` per message page rather than one unbounded call:
 * `conversationReactions` is itself page-shaped ("pass the same beforeSeq/
 * limit used for the matching messages() call" — its own doc), and a single
 * oversized call would silently stop covering older messages once a
 * conversation has scrolled past the server's page-size cap.
 *
 * Kept off `useMessages`'s own cache entirely (see `qk.reactions`'s doc) —
 * tallies are per-viewer (`mine`) and change on every tap, far more often
 * than the messages they're attached to.
 */
export function useReactions(conversationId: string, pageParams: (number | undefined)[]) {
  const { api } = useRuntime();
  const results = useQueries({
    queries: pageParams.map((pageParam) => ({
      queryKey: [...qk.reactions(conversationId), pageParam ?? 'latest'],
      queryFn: () => api.conversationReactions(conversationId, pageParam),
      enabled: Boolean(conversationId),
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

/** Toggle one emoji reaction on a DM message. Invalidates every loaded
 *  reaction page for this conversation (the same blanket-invalidate web's
 *  own toggle does) rather than surgically patching one page's cache — the
 *  response is only that one message's new tally, and re-deriving which
 *  page it belongs to isn't worth the complexity for a tap-and-settle
 *  interaction this fast. */
export function useSetReaction(conversationId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji, on }: { messageId: string; emoji: string; on: boolean }) =>
      api.setReaction(messageId, emoji, on),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.reactions(conversationId) });
    },
  });
}
