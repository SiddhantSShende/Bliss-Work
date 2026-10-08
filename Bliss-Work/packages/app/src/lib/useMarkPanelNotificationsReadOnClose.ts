import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { markNotificationsRead } from "./openNotification";

/**
 * Closing the notification panel reads what the panel was showing: the unread rows
 * it had loaded, each by id, through the same server call a row click uses
 * (markNotificationsRead) — so the server holds the read state, the badge drops by
 * what was flipped, and a failure puts the rows back from the server's own answer.
 *
 * Only the loaded rows are named. Unread notifications beyond the loaded pages are
 * not in `notifications`, so they stay unread and keep counting in the badge.
 *
 * Fires on the open → closed transition only, whichever way the panel closed
 * (Escape, backdrop, close button, a row click). Closing a panel with nothing
 * unread in it, or one that never loaded, sends nothing.
 */
export function useMarkPanelNotificationsReadOnClose(open: boolean, notifications: NotificationDTO[]): void {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const wasOpen = useRef(false);
  // The rows as the panel last drew them, read at the moment it closes.
  const shown = useRef(notifications);
  if (open) shown.current = notifications;

  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const unreadIds = shown.current.filter((n) => !n.read).map((n) => n.id);
    void markNotificationsRead({ qc, api }, unreadIds).catch(() => {});
  }, [open, api, qc]);
}
