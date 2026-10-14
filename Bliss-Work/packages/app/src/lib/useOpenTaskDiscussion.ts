import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { qk } from "./queryBridge";
import { useSelectedChat } from "./selectedChat";

/** What a "Chat" button on a task card/sticky widget needs to resolve its
 *  discussion target: the task id, who the OTHER party is for the DM case
 *  (the allocator if I'm an assignee, or the assignee if I'm the allocator —
 *  callers pass whichever applies), or the channel it was assigned to. */
export interface TaskChatTarget {
  taskId: string;
  peerId?: string;
  channelId?: string;
}

/**
 * Open (or silently create) a task's chat discussion — the "Chat" button's
 * backend, mirrored on useOpenDirectMessage's own "open, don't fabricate a
 * message" shape. DM: opens the existing chats section via useSelectedChat,
 * never the URL (see selectedChat.tsx). Channel: navigates to the channel,
 * carrying the task id as a query param (channel ids are already in the URL,
 * unlike a DM's conversation id).
 */
export function useOpenTaskDiscussion() {
  const { api } = useRuntime();
  const { t } = useTranslation("stickies");
  const qc = useQueryClient();
  const { openChat } = useSelectedChat();
  const navigate = useNavigate();
  const currentUserId = useSession((s) => s.user?.id);
  const [busy, setBusy] = useState(false);

  const openDiscussion = async ({ taskId, peerId, channelId }: TaskChatTarget) => {
    if ((peerId == null) === (channelId == null)) {
      // Programmer error (both or neither supplied) — nothing a retry fixes.
      return;
    }
    setBusy(true);
    try {
      if (peerId) {
        // A task sent to yourself has no second party for a DM — messaging-svc
        // rejects peerId === caller with 400 ("cannot open a task discussion
        // with yourself"). Open the caller's own Notes-to-Self instead, via
        // the same idempotent entry point the pinned chats-list row uses
        // (useSelfChat) — not a task discussion, just the plain self-chat.
        if (peerId === currentUserId) {
          const { conversationId } = await api.openSelfChat();
          openChat(conversationId);
          return;
        }
        const d = await api.openTaskDiscussion(taskId, { peerId });
        await qc.invalidateQueries({ queryKey: qk.taskDiscussions });
        if (d.conversationId) openChat(d.conversationId, { taskId });
      } else if (channelId) {
        await api.openTaskDiscussion(taskId, { channelId });
        await qc.invalidateQueries({ queryKey: qk.taskDiscussions });
        navigate(`/app/channels/${channelId}?taskId=${taskId}`);
      }
    } catch {
      toast.error(t("toasts.chatOpenFailed"));
    } finally {
      setBusy(false);
    }
  };

  return { openDiscussion, busy };
}
