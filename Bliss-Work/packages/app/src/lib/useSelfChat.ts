import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "./runtime";
import { useSelectedChat } from "./selectedChat";

/**
 * Opens (or silently creates) the caller's Notes-to-Self conversation and
 * puts the chats section on it — the same "open, don't fabricate a message"
 * shape as useOpenTaskDiscussion's openDiscussion. Idempotent server-side
 * (store.OpenSelfChat): called from the chat list's pinned row every time it
 * is clicked, never cached locally as "already open", so a stale or
 * never-synced local conversations list can't leave the row looking dead.
 */
export function useOpenSelfChat() {
  const { api } = useRuntime();
  const { t } = useTranslation("chatList");
  const { openChat } = useSelectedChat();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const { conversationId } = await api.openSelfChat();
      openChat(conversationId);
    } catch {
      toast.error(t("chatsList.selfChat.openFailed"));
    } finally {
      setBusy(false);
    }
  };

  return { open, busy };
}
