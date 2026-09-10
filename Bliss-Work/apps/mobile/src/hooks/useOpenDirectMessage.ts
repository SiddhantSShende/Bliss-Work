import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/**
 * Open (or silently create) the DM with one peer — mobile twin of
 * `useOpenDirectMessage` (packages/app/src/lib/useOpenDirectMessage.ts),
 * which selects a chat via a web-only `useSelectedChat` URL store. Mobile has
 * no URL to select through, so the caller supplies `onOpened` and decides how
 * to navigate — `peerId` is handed back alongside the conversation id since
 * `open` is typically bound once per screen (not once per row), so the
 * callback needs it to know WHICH row's conversation just resolved.
 */
export function useOpenDirectMessage(onOpened: (conversationId: string, peerId: string) => void) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [opening, setOpening] = useState(false);

  const open = async (peerId: string, existingConversationId?: string) => {
    if (existingConversationId) return onOpened(existingConversationId, peerId);
    setOpening(true);
    try {
      const { conversationId } = await api.openConversation(peerId);
      await qc.invalidateQueries({ queryKey: qk.conversations });
      onOpened(conversationId, peerId);
    } finally {
      setOpening(false);
    }
  };

  return { open, opening };
}
