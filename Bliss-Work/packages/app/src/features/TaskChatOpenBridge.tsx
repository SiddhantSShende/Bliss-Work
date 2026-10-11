import { useEffect } from "react";
import { useRuntime } from "../lib/runtime";
import { useOpenTaskDiscussion } from "../lib/useOpenTaskDiscussion";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs the sticky overlay's Chat button through the same open-or-create code
 * the in-app Chat button uses (useOpenTaskDiscussion) — the overlay window
 * has no router of its own, so main forwards the click here instead (see
 * main/task-chat-open.ts). Mirrors NotificationClickBridge's shape exactly.
 *
 * The overlay only ever has the taskId, so this re-resolves the task (the
 * same assignee-or-sender detail endpoint the task pages already use) to
 * learn whether it's a DM (senderId) or channel (channelId) discussion —
 * re-validated here rather than trusted over IPC.
 */
export function TaskChatOpenBridge() {
  const { config, api } = useRuntime();
  const { openDiscussion } = useOpenTaskDiscussion();

  useEffect(
    () =>
      config.onTaskChatOpen?.(({ taskId }) => {
        if (!UUID.test(taskId)) return;
        void api
          .taskDetail(taskId)
          .then((task) =>
            openDiscussion(
              task.channelId
                ? { taskId, channelId: task.channelId }
                : { taskId, peerId: task.senderId },
            ),
          )
          .catch(() => {});
      }),
    [config, api, openDiscussion],
  );
  return null;
}
