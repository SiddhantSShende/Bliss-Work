import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { NotificationDTO, NotificationPageDTO } from "@taskboard/shared";
import { qk } from "./queryKeys";

export type NotificationPages = InfiniteData<NotificationPageDTO, unknown>;

export function flattenNotificationPages(data: NotificationPages | undefined): NotificationDTO[] {
  if (!data) return [];
  const byId = new Map<string, NotificationDTO>();
  for (const page of data.pages) {
    for (const notification of page.items) {
      const existing = byId.get(notification.id);
      byId.set(
        notification.id,
        existing ? { ...notification, read: existing.read || notification.read } : notification,
      );
    }
  }
  return [...byId.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

/** The unread and read feeds as one newest-first list, one row per id. A row
 *  marked read locally can sit in the unread feed's cache until it refetches
 *  while the read feed also returns it; `read` wins so it is never shown twice
 *  or as unread. */
export function mergeNotificationFeeds(
  ...feeds: (NotificationPages | undefined)[]
): NotificationDTO[] {
  const byId = new Map<string, NotificationDTO>();
  for (const n of feeds.flatMap(flattenNotificationPages)) {
    const existing = byId.get(n.id);
    byId.set(n.id, existing ? { ...n, read: existing.read || n.read } : n);
  }
  return [...byId.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export function mapNotificationPages(
  data: NotificationPages | undefined,
  update: (notification: NotificationDTO) => NotificationDTO,
): NotificationPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map(update),
    })),
  };
}

export function insertNotificationIntoPages(
  data: NotificationPages | undefined,
  notification: NotificationDTO,
): NotificationPages | undefined {
  if (!data || data.pages.some((page) => page.items.some((item) => item.id === notification.id))) {
    return data;
  }
  const first = data.pages[0];
  if (!first) return data;
  const rest = data.pages.slice(1);
  return {
    ...data,
    pages: [
      {
        ...first,
        items: [notification, ...first.items].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        ),
      },
      ...rest,
    ],
  };
}

/**
 * Returns true when this call inserted the notification, false when it was
 * already known (loaded in a page, or seen on an earlier frame). Callers that
 * announce a notification live use it so a redelivered frame cannot announce
 * twice.
 */
export function addRealtimeNotification(qc: QueryClient, notification: NotificationDTO): boolean {
  const current = qc.getQueryData<NotificationPages>(qk.notifications);
  const alreadyLoaded = current?.pages.some((page) => page.items.some((item) => item.id === notification.id));
  const seen = qc.getQueryData<string[]>(qk.notificationEventIds) ?? [];
  if (alreadyLoaded || seen.includes(notification.id)) return false;

  qc.setQueryData(qk.notificationEventIds, [...seen.slice(-499), notification.id]);
  qc.setQueryData<NotificationPages>(qk.notifications, (previous) =>
    insertNotificationIntoPages(previous, notification),
  );
  qc.setQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount, (previous) =>
    previous && { unreadCount: previous.unreadCount + 1 },
  );
  return true;
}

export function markNotificationPagesRead(
  qc: QueryClient,
  predicate: (notification: NotificationDTO) => boolean,
): number {
  let flipped = 0;
  qc.setQueryData<NotificationPages>(qk.notifications, (previous) =>
    mapNotificationPages(previous, (notification) => {
      if (notification.read || !predicate(notification)) return notification;
      flipped++;
      return { ...notification, read: true };
    }),
  );
  return flipped;
}