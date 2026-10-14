/**
 * The sidebar's Tasks badge and Channels badge must stay independent: a channel
 * message notification increments only the Channels badge, a task notification
 * increments only the Tasks badge, and reading/receiving one kind never moves
 * the other's count.
 *
 * The Channels badge comes from a wholly separate query (messaging-svc's
 * `qk.unreadCounts`, see useSyncUnreadCounts.ts) that a notification-svc event
 * never touches, so the cross-contamination bug lived entirely in how
 * `qk.notificationsUnreadCount`'s two fields (`unreadCount` for the bell,
 * `tasksUnreadCount` for the Tasks badge — see AppShell.tsx) were kept in sync
 * with incoming/read notifications of mixed kinds. These two functions are
 * where that happens; this pins both fields moving correctly, independently,
 * for every kind combination that can occur.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { NotificationDTO } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { addRealtimeNotification, markNotificationPagesRead, type NotificationPages } from "./notificationPages";
import { decrementUnreadCount } from "./unreadNotificationCount";

const BASE: Omit<NotificationDTO, "id" | "kind"> = {
  text: "n",
  taskId: null,
  read: false,
  createdAt: "2026-10-14T09:00:00.000Z",
};

function notification(id: string, kind: string): NotificationDTO {
  return { ...BASE, id, kind };
}

function qcWith(count: { unreadCount: number; tasksUnreadCount: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.notificationsUnreadCount, count);
  return qc;
}

const counts = (qc: QueryClient) => qc.getQueryData<{ unreadCount: number; tasksUnreadCount: number }>(qk.notificationsUnreadCount);

describe("the Tasks badge and the Channels/bell count stay independent", () => {
  it("a realtime CHANNEL_MESSAGE notification raises the bell but not the Tasks count", () => {
    const qc = qcWith({ unreadCount: 0, tasksUnreadCount: 0 });
    addRealtimeNotification(qc, notification("c1", "CHANNEL_MESSAGE"));
    expect(counts(qc)).toEqual({ unreadCount: 1, tasksUnreadCount: 0 });
  });

  it("a realtime TASK_ASSIGNED notification raises both the bell and the Tasks count", () => {
    const qc = qcWith({ unreadCount: 0, tasksUnreadCount: 0 });
    addRealtimeNotification(qc, notification("t1", "TASK_ASSIGNED"));
    expect(counts(qc)).toEqual({ unreadCount: 1, tasksUnreadCount: 1 });
  });

  it("mixed realtime arrivals (task, channel, DM, meeting) produce correct independent counts", () => {
    const qc = qcWith({ unreadCount: 0, tasksUnreadCount: 0 });
    addRealtimeNotification(qc, notification("t1", "TASK_ASSIGNED"));
    addRealtimeNotification(qc, notification("c1", "CHANNEL_MESSAGE"));
    addRealtimeNotification(qc, notification("d1", "DM_MESSAGE"));
    addRealtimeNotification(qc, notification("m1", "MEETING_INVITATION"));
    addRealtimeNotification(qc, notification("t2", "TASK_COMPLETED"));
    // 5 notifications of any kind, only the 2 TASK_* ones count toward Tasks.
    expect(counts(qc)).toEqual({ unreadCount: 5, tasksUnreadCount: 2 });
  });

  it("markNotificationPagesRead splits the task-kind subset out of mixed rows", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rows = [
      notification("t1", "TASK_ASSIGNED"),
      notification("c1", "CHANNEL_MESSAGE"),
      notification("c2", "CHANNEL_ADDED"),
      notification("t2", "TASK_COMPLETED"),
    ];
    qc.setQueryData<NotificationPages>(qk.notifications, { pages: [{ items: rows, nextCursor: null }], pageParams: [undefined] });

    const flipped = markNotificationPagesRead(qc, () => true);
    expect(flipped).toEqual({ total: 4, tasks: 2 });
  });

  it("reading a channel notification lowers the bell but leaves the Tasks badge untouched", () => {
    const qc = qcWith({ unreadCount: 5, tasksUnreadCount: 2 });
    // markNotificationPagesRead found 1 row, 0 of them task-kind (a channel read).
    decrementUnreadCount(qc, 1, 0);
    expect(counts(qc)).toEqual({ unreadCount: 4, tasksUnreadCount: 2 });
  });

  it("reading a task notification lowers both the bell and the Tasks badge, by the same amount", () => {
    const qc = qcWith({ unreadCount: 5, tasksUnreadCount: 2 });
    decrementUnreadCount(qc, 1, 1);
    expect(counts(qc)).toEqual({ unreadCount: 4, tasksUnreadCount: 1 });
  });

  it("reading a mixed batch (one task, one channel) lowers the Tasks badge by only the task's share", () => {
    const qc = qcWith({ unreadCount: 5, tasksUnreadCount: 2 });
    decrementUnreadCount(qc, 2, 1);
    expect(counts(qc)).toEqual({ unreadCount: 3, tasksUnreadCount: 1 });
  });

  it("clamps the Tasks count at zero independently of the bell", () => {
    const qc = qcWith({ unreadCount: 3, tasksUnreadCount: 0 });
    decrementUnreadCount(qc, 3, 3); // stale-low tasksUnreadCount cache
    expect(counts(qc)).toEqual({ unreadCount: 0, tasksUnreadCount: 0 });
  });
});
