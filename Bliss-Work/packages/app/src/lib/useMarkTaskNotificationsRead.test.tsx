/**
 * Opening the Tasks section marks the task notifications it shows as read. The
 * bell badge and the Tasks rail dot read a SEPARATE server-side count
 * (qk.notificationsUnreadCount), so patching the notification list is not enough:
 * the count has to be lowered optimistically and then refetched once the
 * requests settle. These pin that, against a fake server so "the server has the
 * last word" is checked with real refetched data.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO, NotificationPageDTO } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { useMarkTaskNotificationsRead } from "./useMarkTaskNotificationsRead";
import { flattenNotificationPages } from "./notificationPages";

const TASK_A = "018f0000-0000-7000-8000-0000000000a1";
const TASK_B = "018f0000-0000-7000-8000-0000000000a2";
const OTHER_TASK = "018f0000-0000-7000-8000-0000000000c9";

function notification(id: string, taskId: string | null, read = false): NotificationDTO {
  return {
    id,
    kind: taskId ? "TASK_COMPLETED" : "CHANNEL_ADDED",
    text: "…",
    taskId,
    read,
    createdAt: "2026-08-01T09:05:00.000Z",
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Setup {
  notifications: NotificationDTO[];
  taskIds: string[];
  /** How each mark-read request behaves; defaults to succeeding at once. */
  read?: (id: string) => Promise<void>;
  /** The count already in the cache; defaults to the true number of unread rows. */
  cachedCount?: number;
  /** How many copies of the hook to mount (TasksList mounts two). */
  instances?: number;
}

function setup({ notifications, taskIds, read = async () => {}, cachedCount, instances = 1 }: Setup) {
  // The "server": a row is unread until a mark-read request for it succeeds.
  const serverRead = new Set(notifications.filter((n) => n.read).map((n) => n.id));
  const serverUnread = () => notifications.filter((n) => !serverRead.has(n.id)).length;
  const fns = {
    notifications: vi.fn(async () => notifications),
    notificationPage: vi.fn(async (): Promise<NotificationPageDTO> => ({ items: notifications, nextCursor: null })),
    notificationsUnreadCount: vi.fn(async () => ({ unreadCount: serverUnread() })),
    markNotificationRead: vi.fn(async (id: string) => {
      await read(id);
      serverRead.add(id);
    }),
  };
  const api = fns as unknown as ApiClient;

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.notifications, { pages: [{ items: notifications, nextCursor: null }], pageParams: [undefined] });
  qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: cachedCount ?? serverUnread() });

  renderHook(
    () => {
      const tasks = taskIds.map((taskId) => ({ taskId }));
      for (let i = 0; i < instances; i++) useMarkTaskNotificationsRead(api, tasks); // eslint-disable-line react-hooks/rules-of-hooks
      // The badge, as AppShell runs it — an active observer, so it refetches when invalidated.
      return useQuery({
        queryKey: qk.notificationsUnreadCount,
        queryFn: () => api.notificationsUnreadCount(),
      });
    },
    { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> },
  );

  const badge = () => qc.getQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount)?.unreadCount;
  const listRead = (id: string) => flattenNotificationPages(qc.getQueryData(qk.notifications)).find((n) => n.id === id)?.read;
  return { fns, badge, listRead };
}

describe("useMarkTaskNotificationsRead", () => {
  it("marks only the unread notifications of the visible tasks", async () => {
    const { fns, listRead } = setup({
      taskIds: [TASK_A, TASK_B],
      notifications: [
        notification("n1", TASK_A),
        notification("n2", TASK_B),
        notification("n3", OTHER_TASK), // a task that isn't on screen
        notification("n4", TASK_A, true), // already read
        notification("n5", null), // CHANNEL_ADDED: not a task notification at all
      ],
    });

    await waitFor(() => expect(fns.markNotificationRead).toHaveBeenCalledTimes(2));
    expect(fns.markNotificationRead).toHaveBeenCalledWith("n1");
    expect(fns.markNotificationRead).toHaveBeenCalledWith("n2");
    expect([listRead("n1"), listRead("n2")]).toEqual([true, true]);
    expect([listRead("n3"), listRead("n5")]).toEqual([false, false]);
  });

  it("lowers the badge at once, by the notifications being marked and nothing else", () => {
    const { fns, badge } = setup({
      taskIds: [TASK_A, TASK_B],
      read: () => new Promise(() => {}), // requests still in flight
      notifications: [
        notification("n1", TASK_A),
        notification("n2", TASK_B),
        notification("n3", OTHER_TASK),
        notification("n5", null),
      ],
    });

    expect(badge()).toBe(4 - 2); // the two matches only; unrelated unread stay counted
    expect(fns.notificationsUnreadCount).not.toHaveBeenCalled(); // no refetch yet
  });

  it("never takes the badge below zero", () => {
    const { badge } = setup({
      taskIds: [TASK_A],
      cachedCount: 1, // out of step with the list: two unread matches, count says one
      read: () => new Promise(() => {}),
      notifications: [notification("n1", TASK_A), notification("n2", TASK_A)],
    });

    expect(badge()).toBe(0);
  });

  it("refetches the count only after every request has settled", async () => {
    const first = deferred();
    const second = deferred();
    const { fns, badge } = setup({
      taskIds: [TASK_A, TASK_B],
      read: (id) => (id === "n1" ? first.promise : second.promise),
      notifications: [notification("n1", TASK_A), notification("n2", TASK_B), notification("n3", OTHER_TASK)],
    });

    await act(async () => first.resolve());
    await new Promise((r) => setTimeout(r, 20));
    expect(fns.notificationsUnreadCount).not.toHaveBeenCalled(); // one request is still out

    await act(async () => second.resolve());
    await waitFor(() => expect(fns.notificationsUnreadCount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(badge()).toBe(1)); // only the unrelated n3 is left, per the server
  });

  it("puts the badge back when a request fails, because the final refetch is the server's word", async () => {
    const { fns, badge } = setup({
      taskIds: [TASK_A, TASK_B],
      read: async (id) => {
        if (id === "n1") throw new Error("offline");
      },
      notifications: [notification("n1", TASK_A), notification("n2", TASK_B), notification("n3", OTHER_TASK)],
    });

    expect(badge()).toBe(1); // optimistic: 3 − 2
    await waitFor(() => expect(fns.notificationsUnreadCount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(badge()).toBe(2)); // n1 never got read on the server, n3 never touched
  });

  it("leaves the badge and the server alone when nothing on screen has a notification", async () => {
    const { fns, badge } = setup({
      taskIds: [TASK_A],
      notifications: [notification("n3", OTHER_TASK), notification("n5", null)],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(fns.markNotificationRead).not.toHaveBeenCalled();
    expect(fns.notificationsUnreadCount).not.toHaveBeenCalled();
    expect(badge()).toBe(2);
  });

  it("counts a notification once when two mounted copies both match it (a self-assigned task is in both lists)", () => {
    const { badge } = setup({
      taskIds: [TASK_A],
      instances: 2,
      read: () => new Promise(() => {}),
      notifications: [notification("n1", TASK_A), notification("n3", OTHER_TASK)],
    });

    expect(badge()).toBe(1); // 2 − 1, not 2 − 2
  });
});
