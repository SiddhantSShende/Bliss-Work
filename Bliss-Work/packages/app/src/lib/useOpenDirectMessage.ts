import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";
import { useSelectedChat } from "./selectedChat";

/**
 * Open (or silently create) the DM with one peer, from wherever a "Message"
 * action appears on a member — this used to post "👋 Hi {name}!" because
 * sending was the only way to create a conversation row.
 */
export function useOpenDirectMessage() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const { openChat } = useSelectedChat();
  const [opening, setOpening] = useState(false);

  const open = async (peerId: string, existingConversationId?: string) => {
    // openChat rather than a nav to /app/chats/<id>: it selects and moves to
    // the section in one step, so the id is never put in the URL at all rather
    // than put there and redirected away.
    if (existingConversationId) return openChat(existingConversationId);
    setOpening(true);
    try {
      const { conversationId } = await api.openConversation(peerId);
      // DMView reads its header from the conversation list, so refresh it before
      // navigating or a brand-new chat flashes "Conversation not found".
      await qc.invalidateQueries({ queryKey: qk.conversations });
      openChat(conversationId);
    } finally {
      setOpening(false);
    }
  };

  return { open, opening };
}
