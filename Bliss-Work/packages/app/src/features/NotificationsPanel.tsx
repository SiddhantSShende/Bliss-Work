import { useTranslation } from "react-i18next";
import { CheckCheck, Bell, CalendarDays, Hash, MessageSquare } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { ChannelDTO, ConversationDTO, NotificationDTO } from "@taskboard/shared";
import { isReadInFlight, useNotificationActions } from "../lib/openNotification";
import { qk } from "../lib/queryKeys";
import { resolveMessageNotification } from "../lib/messageNotificationLabel";
import { useMarkPanelNotificationsReadOnClose } from "../lib/useMarkPanelNotificationsReadOnClose";
import { notificationCategory, notificationDestination, type NotificationCategory } from "../lib/notificationDestination";

// Kept exported from here: it is where callers have always imported it from.
export { notificationDestination };
import { Sheet } from "./Modal";

/** One server-filtered feed (unread or read): whether its first page is still in
 *  flight, whether it failed, and how to page further. */
export interface NotificationFeedState {
  loading: boolean;
  /** The request errored. Not the same as "empty": nothing is known. */
  failed?: boolean;
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
  unreadCount = 0,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  /** Both feeds merged, one row per id. */
  notifications: NotificationDTO[];
  unreadFeed?: NotificationFeedState;
  readFeed?: NotificationFeedState;
  /** The bell's own (server) unread count. Never decides what the list holds —
   *  but a badge that says something is unread beside a list with nothing in it
   *  means the list did not load, and is shown as that, not as "no notifications". */
  unreadCount?: number;
  /** Reload both feeds. */
  onRetry?: () => void;
}) {
  const { t, i18n } = useTranslation("shell");
  // A notification becomes read when the user acts on it (clicks the row or "Mark
  // read") — and when the panel is closed, for every unread row it had loaded
  // (see useMarkPanelNotificationsReadOnClose). All of it goes through the same
  // server call the toast and the desktop popup use; the badge is the server's
  // unread count and follows it.
  const { markRead, open: openNotification } = useNotificationActions();
  useMarkPanelNotificationsReadOnClose(open, notifications);
  const qc = useQueryClient();
  // Names come from what the app already holds, by id — never a request of their own.
  const conversations = qc.getQueryData<ConversationDTO[]>(qk.conversations);
  const channels = qc.getQueryData<ChannelDTO[]>(qk.channels);
  const onOpen = (notification: NotificationDTO) => {
    onClose();
    openNotification(notification);
  };

  // The panel is the user's notification HISTORY: every notification, read or
  // not. Unread ones come first — they are what the badge counts — then the read
  // ones, each newest first. Partitioned by read state alone, never by kind, and
  // each id is in exactly one of the two groups, so a row is never drawn twice and
  // marking one read changes how it looks and where it sits, never whether it is
  // there.
  //
  // A row whose read request is still on the wire counts as read: a panel
  // reopened right after it was closed must not light those rows up again.
  const isRead = (n: NotificationDTO) => n.read || isReadInFlight(n.id);
  const unread = notifications.filter((n) => !isRead(n));
  const read = notifications.filter(isRead);
  const shown = [...unread, ...read];

  // "Nothing here" is only established once both feeds have answered: neither
  // first page is still in flight.
  const loading = shown.length === 0 && (unreadFeed.loading || readFeed.loading);
  const failed = !!(unreadFeed.failed || readFeed.failed);
  // The list holds nothing although the feeds did not fail — yet the badge says
  // something is unread. Whatever is wrong, "No notifications yet" is not true.
  const inconsistent = shown.length === 0 && !loading && unreadCount > 0;
  const loadFailed = shown.length === 0 && !loading && (failed || inconsistent);

  // Unread first, then read: Load more pages the unread feed until it is
  // exhausted, then the read history.
  const hasMore = unreadFeed.hasNextPage || readFeed.hasNextPage;
  const fetchingMore = unreadFeed.isFetchingNextPage || readFeed.isFetchingNextPage;
  const loadMore = () => (unreadFeed.hasNextPage ? unreadFeed : readFeed).loadMore();

  return (
    <Sheet open={open} onClose={onClose} title={t("notifications.title")}>
      {loading ? (
        <p className="py-6 text-center text-sm text-muted">{t("notifications.loadingMore")}</p>
      ) : loadFailed ? (
        <div className="flex flex-col items-center">
          <EmptyState
            icon={<Bell size={22} />}
            title={t("notifications.error.title")}
            hint={t("notifications.error.hint")}
          />
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
            >
              {t("notifications.error.retry")}
            </button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={t("notifications.empty.noneYet")}
          hint={t("notifications.empty.hint")}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {shown.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                isRead(n) ? "border-border opacity-70" : "border-accent/30 bg-accent-soft/50"
              }`}
            >
              <div
                data-category={notificationCategory(n.kind)}
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"
              >
                <CategoryIcon category={notificationCategory(n.kind)} />
              </div>
              <div className="min-w-0 flex-1 break-words">
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => onOpen(n)}
                >
                  <NotificationText notification={n} conversations={conversations} channels={channels} />
                  <span className="mt-0.5 block text-xs text-muted">
                    {new Date(n.createdAt).toLocaleString(i18n.language)}
                  </span>
                </button>
              </div>
              {!isRead(n) && (
                <button className="shrink-0 text-xs font-medium text-accent hover:underline" onClick={() => markRead(n.id)}>
                  {t("notifications.row.markRead")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {failed && shown.length > 0 && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 w-full rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {t("notifications.error.partial")}
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

/** A channel invitation under a double-tick reads as "your task was completed", the
 *  opposite of what happened — so only task kinds get the tick, and a kind this build
 *  does not know gets the neutral bell rather than borrowing another family's icon. */
function CategoryIcon({ category }: { category: NotificationCategory }) {
  switch (category) {
    case "task":
      return <CheckCheck size={16} />;
    case "chat":
      return <MessageSquare size={16} />;
    case "channel":
      return <Hash size={16} />;
    case "meeting":
      return <CalendarDays size={16} />;
    default:
      return <Bell size={16} />;
  }
}

function NotificationText({
  notification,
  conversations,
  channels,
}: {
  notification: NotificationDTO;
  conversations?: ConversationDTO[];
  channels?: ChannelDTO[];
}) {
  const { t } = useTranslation("shell");
  if (notification.kind === "DM_MESSAGE" || notification.kind === "CHANNEL_MESSAGE") {
    const { sender, channel } = resolveMessageNotification(notification, conversations, channels);
    const where = notification.kind === "CHANNEL_MESSAGE" ? ` · ${channel ? `#${channel}` : t("notifications.message.aChannel")}` : "";
    return (
      <span className="block break-words text-sm">
        <span className="block font-semibold text-fg">{t("notifications.message.title")}</span>
        <span className="block font-medium text-accent">{`${sender ?? t("notifications.message.someone")}${where}`}</span>
        <span className="block text-muted">{t("notifications.message.body")}</span>
      </span>
    );
  }
  return <span className="block break-words text-sm text-fg">{notification.text}</span>;
}
