import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO, NotificationReadTarget } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { markNotificationPagesRead } from "./notificationPages";
import { decrementUnreadCount, refreshUnreadCount } from "./unreadNotificationCount";

/**
 * Opening a chat, a channel or a meeting reads that one's notifications — the same
 * rule the Tasks section already follows (useMarkTaskNotificationsRead), recorded
 * the same way: on the SERVER, where read state lives, scoped to the one thing
 * that was opened. Not worked out from the bell panel's list cache, which is empty
 * until the bell has been opened once.
 *
 * Scoped by design. The server takes exactly one conversation, channel or call id,
 * so another chat's, channel's or meeting's notifications — and every task's — are
 * left lit, and there is nothing here that can mark everything read. Clicking one
 * row in the bell still reads just that row (openNotification.ts).
 */

type TargetField = "conversationId" | "channelId" | "callId";

/** The notification rows a target names, for patching the cached lists. */
function belongsTo(n: NotificationDTO, field: TargetField, id: string): boolean {
  return n[field] === id;
}

/**
 * Ask the server to read this target's notifications, then bring the cached bell
 * state in line: the rows it names go read, the badge drops by what the SERVER
 * says changed, and the count is refetched so a failed or partial call is put
 * right rather than trusted.
 */
export async function markTargetNotificationsRead(
  api: ApiClient,
  qc: QueryClient,
  field: TargetField,
  id: string,
): Promise<void> {
  let updated: number;
  try {
    const target: NotificationReadTarget =
      field === "conversationId"
        ? { conversationId: id }
        : field === "channelId"
          ? { channelId: id }
          : { callId: id };
    ({ updated } = await api.markNotificationsReadByTarget(target));
  } catch {
    return; // nothing was marked; the badge is still right (and an older server has no such route)
  }
  if (updated === 0) return;

  markNotificationPagesRead(qc, (n) => belongsTo(n, field, id));
  // A target is a conversation, a channel or a call — never a task — so this
  // only ever lowers the bell, never the Tasks badge.
  decrementUnreadCount(qc, updated);
  void qc.invalidateQueries({ queryKey: qk.notificationsRead });
  void refreshUnreadCount(qc);
}

/**
 * Read a chat's / channel's / meeting's notifications when it is opened — once
 * per open, and again each time the id changes (the views are reused across a
 * change of conversation, not remounted).
 *
 * Skipped only when the badge is already KNOWN to be zero: a count that has not
 * loaded yet proves nothing, and a chat opened straight from a reload would
 * otherwise leave its notifications lit.
 */
export function useMarkTargetNotificationsRead(
  api: ApiClient,
  field: TargetField,
  id: string | null | undefined,
): void {
  const qc = useQueryClient();
  const marked = useRef<string | null>(null);

  useEffect(() => {
    if (!id) {
      marked.current = null;
      return;
    }
    const key = `${field}:${id}`;
    if (marked.current === key) return;
    marked.current = key;
    if (qc.getQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount)?.unreadCount === 0) return;
    void markTargetNotificationsRead(api, qc, field, id);
  }, [api, qc, field, id]);
}
