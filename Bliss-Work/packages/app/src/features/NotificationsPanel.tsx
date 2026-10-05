import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCheck, Bell, CalendarDays, Hash, MessageSquare } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { decrementUnreadCount, refreshUnreadCount } from "../lib/unreadNotificationCount";
import { markNotificationPagesRead } from "../lib/notificationPages";
import { notificationDestination, openNotificationRoute } from "../lib/notificationDestination";

// Kept exported from here: it is where callers have always imported it from.
export { notificationDestination };
import { Sheet } from "./Modal";

/** One server-filtered feed (unread or read): whether its first page is still in
 *  flight, and how to page further. */
export interface NotificationFeedState {
  loading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
}
const IDLE_FEED: NotificationFeedState = {
  loading: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  loadMore: () => {},
};

export function NotificationsPanel({
  open,
  onClose,
  notifications,
  unreadFeed = IDLE_FEED,
  readFeed = IDLE_FEED,
}: {
  open: boolean;
  onClose: () => void;
  /** Both feeds merged, one row per id. */
  notifications: NotificationDTO[];
  unreadFeed?: NotificationFeedState;
  readFeed?: NotificationFeedState;
}) {
  const { t, i18n } = useTranslation("shell");
  const { api } = useRuntime();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const [showRead, setShowRead] = useState(false);

  // Collapse the history again whenever the panel closes, so reopening always
  // answers "what's new?" rather than resuming a browse session.
  useEffect(() => {
    if (!open) setShowRead(false);
  }, [open]);

  // Opening or closing the panel never changes read state. A notification only
  // becomes read when the user acts on it (clicks the row or "Mark read"); the
  // badge is the server's unread count and moves only through those actions.
  const markRead = async (id: string) => {
    // Flip the row and lower the badge BEFORE the request, so the UI answers the
    // click immediately; the refresh below lets the server have the last word.
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
    openNotificationRoute(navigate, pathname, notificationDestination(notification));
  };

  // Read notifications are HISTORY, not news: unread by default, the rest one
  // click away. Partitioned by read state alone — never by kind — and each id is
  // in exactly one of the two lists, so toggling never shows a row twice.
  const unread = notifications.filter((n) => !n.read);
  const read = notifications.filter((n) => n.read);
  const shown = showRead ? [...unread, ...read] : unread;
  const readCount = read.length;

  // The unread feed is filtered on the server, but rows marked read locally stay
  // in its cache until it refetches. If those hide the whole loaded page while
  // more pages exist, keep paging rather than claim there is nothing unread.
  const needMoreUnread = !showRead && unread.length === 0 && unreadFeed.hasNextPage;
  const loadMoreUnread = useRef(unreadFeed.loadMore);
  loadMoreUnread.current = unreadFeed.loadMore;
  useEffect(() => {
    if (open && needMoreUnread && !unreadFeed.isFetchingNextPage) loadMoreUnread.current();
  }, [open, needMoreUnread, unreadFeed.isFetchingNextPage]);

  // "Nothing here" is only established once the feeds say so: the unread feed has
  // answered and has no further pages, and — when it is empty — the read feed has
  // answered too, so we know which empty state is true.
  const loading =
    shown.length === 0 && (unreadFeed.loading || needMoreUnread || unreadFeed.isFetchingNextPage || readFeed.loading);
  // Load more pages the feed the current view is still short of.
  const hasMore = showRead ? unreadFeed.hasNextPage || readFeed.hasNextPage : unreadFeed.hasNextPage;
  const fetchingMore = showRead
    ? unreadFeed.isFetchingNextPage || readFeed.isFetchingNextPage
    : unreadFeed.isFetchingNextPage;
  const loadMore = () => (showRead && !unreadFeed.hasNextPage ? readFeed : unreadFeed).loadMore();

  return (
    <Sheet open={open} onClose={onClose} title={t("notifications.title")}>
      {loading ? (
        <p className="py-6 text-center text-sm text-muted">{t("notifications.loadingMore")}</p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={readCount > 0 ? t("notifications.empty.allCaughtUp") : t("notifications.empty.noneYet")}
          hint={readCount > 0 ? t("notifications.empty.hintNothingUnread") : t("notifications.empty.hint")}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
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
              <div className="min-w-0 flex-1 break-words">
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
                <button className="shrink-0 text-xs font-medium text-accent hover:underline" onClick={() => markRead(n.id)}>
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
          {showRead ? t("notifications.toggleHideRead") : t("notifications.toggleShowRead", { total: `${readCount}${readFeed.hasNextPage ? "+" : ""}` })}
        </button>
      )}

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={fetchingMore}
          className="mt-3 w-full rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-wait disabled:opacity-60"
        >
          {fetchingMore ? t("notifications.loadingMore") : t("notifications.loadMore")}
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
  return <span className="block break-words text-sm text-fg">{text}</span>;
}
