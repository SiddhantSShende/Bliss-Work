import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCheck, Bell, CalendarDays, Hash, MessageSquare } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { decrementUnreadCount, refreshUnreadCount } from "../lib/unreadNotificationCount";
import { markNotificationPagesRead } from "../lib/notificationPages";
import { Sheet } from "./Modal";

export function NotificationsPanel({
  open,
  onClose,
  notifications,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore = () => {},
}: {
  open: boolean;
  onClose: () => void;
  notifications: NotificationDTO[];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
}) {
  const { t, i18n } = useTranslation("shell");
  const { api } = useRuntime();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showRead, setShowRead] = useState(false);

  // Collapse the history again whenever the panel closes, so reopening always
  // starts from the first page rather than resuming a browse session. On open,
  // keep history visible as bulk-read flips the unread rows in place.
  useEffect(() => {
    setShowRead(open);
  }, [open]);

  // Mark everything read when the panel opens. The server owns the source of
  // truth for unread state, so this is the one place that must issue the bulk
  // read and clear the badge immediately — even if the user only sees a subset
  // of the backlog in the current list view.
  useEffect(() => {
    if (!open) return;

    // The backend count can include unread rows that have not been paged in.
    // Clear it directly and let the bulk endpoint update every persisted row.
    qc.setQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount, (prev) =>
      prev && { ...prev, unreadCount: 0 },
    );
    markNotificationPagesRead(qc, () => true);

    void api
      .readAllNotifications()
      .catch(() => {})
      .then(() => refreshUnreadCount(qc));
  }, [open, api, qc]);

  const markRead = async (id: string) => {
    // Flip the row and lower the badge BEFORE the request, not after it. If the
    // panel closes while the request is out, the close handler's read-all counts
    // the unread rows in the cache — this one has to be read there already, or
    // it comes off the badge twice.
    const flipped = markNotificationPagesRead(qc, (n) => n.id === id);
    decrementUnreadCount(qc, flipped);

    const failed = await api.markNotificationRead(id).then(
      () => false,
      () => true,
    );
    // The server has the last word. Failed: it still holds the row unread, so
    // refetch the list as well and the row comes back; otherwise just the count.
    void (failed ? qc.invalidateQueries({ queryKey: qk.notifications }) : refreshUnreadCount(qc));
  };

  const openNotification = (notification: NotificationDTO) => {
    void markRead(notification.id);
    onClose();
    navigate(notificationDestination(notification));
  };

  // Read notifications are HISTORY, not news. Showing them by default meant the
  // panel looked identical after every reopen — "all my notifications came
  // back, including the ones I'd already read" — because nothing ever left it.
  // They stay one click away rather than being thrown out.
  const unread = notifications.filter((n) => !n.read);
  const shown = showRead ? notifications : unread;
  const readCount = notifications.length - unread.length;

  return (
    <Sheet open={open} onClose={onClose} title={t("notifications.title")}>
      {shown.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={showRead ? t("notifications.empty.noneYet") : t("notifications.empty.allCaughtUp")}
          hint={
            showRead
              ? t("notifications.empty.hintTaskUpdates")
              : readCount > 0
                ? t("notifications.empty.hintNothingUnread")
                : t("notifications.empty.hintTaskUpdates")
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                n.read ? "border-border opacity-70" : "border-accent/30 bg-accent-soft/50"
              }`}
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                {/* A channel invitation under a double-tick reads as "your task
                    was completed", which is the opposite of what happened. */}
                {n.kind === "CHANNEL_ADDED" || n.kind === "CHANNEL_CREATED" ? <Hash size={16} /> : n.kind === "DM_MESSAGE" || n.kind === "CHANNEL_MESSAGE" ? <MessageSquare size={16} /> : n.kind.startsWith("MEETING_") ? <CalendarDays size={16} /> : <CheckCheck size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => void openNotification(n)}
                >
                  <NotificationText notification={n} />
                  <span className="mt-0.5 block text-xs text-muted">
                    {new Date(n.createdAt).toLocaleString(i18n.language)}
                  </span>
                </button>
              </div>
              {!n.read && (
                <button className="text-xs font-medium text-accent hover:underline" onClick={() => markRead(n.id)}>
                  {t("notifications.row.markRead")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readCount > 0 && (
        <button
          onClick={() => setShowRead((v) => !v)}
          className="mt-3 w-full rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {showRead ? t("notifications.toggleHideRead") : t("notifications.toggleShowRead", { count: readCount })}
        </button>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isFetchingNextPage}
          className="mt-3 w-full rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-wait disabled:opacity-60"
        >
          {isFetchingNextPage ? t("notifications.loadingMore") : t("notifications.loadMore")}
        </button>
      )}
    </Sheet>
  );
}

function NotificationText({ notification }: { notification: NotificationDTO }) {
  const text = notification.text;
  if (notification.kind === "DM_MESSAGE") {
    const separator = text.indexOf(": ");
    if (separator > 0) {
      return (
        <span className="block text-sm text-fg">
          <span className="font-medium">{text.slice(0, separator)}</span>
          <span className="block">{text.slice(separator + 2)}</span>
        </span>
      );
    }
  }
  if (notification.kind === "CHANNEL_MESSAGE") {
    const separator = text.indexOf(": ");
    const channelMarker = text.indexOf(" in #");
    if (separator > 0 && channelMarker > 0 && channelMarker < separator) {
      return (
        <span className="block text-sm text-fg">
          <span className="font-medium">
            {text.slice(0, channelMarker)}
            <span className="font-normal text-muted"> · {text.slice(channelMarker + 5, separator)}</span>
          </span>
          <span className="block">{text.slice(separator + 2)}</span>
        </span>
      );
    }
  }
  return <span className="block text-sm text-fg">{text}</span>;
}

export function notificationDestination(notification: NotificationDTO): string {
  switch (notification.kind) {
    case "CHANNEL_ADDED":
    case "CHANNEL_CREATED":
    case "CHANNEL_MESSAGE":
      return notification.channelId ? `/app/channels/${notification.channelId}` : "/app/channels";
    case "DM_MESSAGE":
      return notification.conversationId ? `/app/chats/${notification.conversationId}` : "/app/chats";
    case "MEETING_SCHEDULED":
    case "MEETING_INVITATION":
      return notification.callId ? `/app/meetings/${notification.callId}` : "/app/meetings";
    case "TASK_ACKNOWLEDGED":
    case "TASK_ASSIGNED":
    case "TASK_COMPLETED":
    case "TASK_IGNORED":
    case "TASK_LEFT":
    case "TASK_WITHDRAWN":
      return notification.taskId ? `/app/mail/task/${notification.taskId}` : "/app/tasks/allocated";
    default: {
      const exhaustive: never = notification.kind;
      return exhaustive;
    }
  }
}
