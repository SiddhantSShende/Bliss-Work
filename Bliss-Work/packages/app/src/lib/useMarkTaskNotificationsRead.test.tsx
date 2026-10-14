/**
 * Opening the Tasks section marks the notifications of the tasks it shows as read,
 * on the SERVER — which is where read state lives — and nothing else.
 *
 * The first version of this found those notifications in the bell panel's list
 * cache, so it silently did nothing until the bell had been opened once (the cache
 * is empty before that), and the badge stayed lit. Every test here therefore starts
 * with NO notification list cached unless it says otherwise: a fake server owns the
 * rows, and what the bell and the panel show is read back from it.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { markTaskNotificationsRead, useMarkTaskNotificationsRead } from "./useMarkTaskNotificationsRead";
import { flattenNotificationPages, type NotificationPages } from "./notificationPages";

const TASK_A = "018f0000-0000-7000-8000-0000000000a1";
const TASK_B = "018f0000-0000-7000-8000-0000000000a2";
const OTHER_TASK = "018f0000-0000-7000-8000-0000000000c9";

function notification(id: string, taskId: string | null, read = false): NotificationDTO {
  return {
    id,
    kind: taskId ? "TASK_ASSIGNED" : "CHANNEL_ADDED",
    text: `n-${id}`,
    taskId,
    read,
    createdAt: "2026-08-01T09:05:00.000Z",
  };
}

/** The notification service: owns the rows, serves the count, and marks by task id. */
function fakeServer(rows: NotificationDTO[], opts: { failMark?: boolean; holdMark?: Promise<void> } = {}) {
  const state = rows.map((n) => ({ ...n }));
  const fns = {
    notificationsUnreadCount: vi.fn(async () => ({
      unreadCount: state.filter((n) => !n.read).length,
      tasksUnreadCount: state.filter((n) => !n.read && n.taskId).length,
    })),
    markTaskNotificationsRead: vi.fn(async (taskIds: string[]) => {
      await opts.holdMark;
      if (opts.failMark) throw new Error("boom");
      let updated = 0;
      for (const n of state) {
        if (!n.read && n.taskId && taskIds.includes(n.taskId)) {
          n.read = true;
          updated++;
        }
      }
      return { updated };
    }),
  };
  return {
    state,
    fns,
    api: fns as unknown as ApiClient,
    unread: () => state.filter((n) => !n.read).map((n) => n.id).sort(),
  };
}

function mount(server: ReturnType<typeof fakeServer>, tasks: { taskId: string }[], opts: { cachedList?: NotificationDTO[] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (opts.cachedList) {
    qc.setQueryData<NotificationPages>(qk.notifications, {
      pages: [{ items: opts.cachedList, nextCursor: null }],
      pageParams: [undefined],
    });
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ tasks }: { tasks: { taskId: string }[] }) => {
      useMarkTaskNotificationsRead(server.api, tasks);
      // The bell, as AppShell runs it: an active observer of the same count.
      return useQuery({ queryKey: qk.notificationsUnreadCount, queryFn: () => server.api.notificationsUnreadCount() });
    },
    { wrapper, initialProps: { tasks } },
  );
  const badge = () => view.result.current.data?.unreadCount;
  return { qc, view, badge };
}

describe("useMarkTaskNotificationsRead", () => {
  it("clears the notification of a visible task although the bell's list was never loaded", async () => {
    const server = fakeServer([notification("assigned", TASK_A)]);
    const { qc, badge } = mount(server, [{ taskId: TASK_A }]);
    expect(qc.getQueryData(qk.notifications)).toBeUndefined(); // the bell was never opened

    await waitFor(() => expect(badge()).toBe(0));

    expect(server.fns.markTaskNotificationsRead).toHaveBeenCalledExactlyOnceWith([TASK_A]);
    expect(server.unread()).toEqual([]); // read on the server, not just in a cache
  });

  it("marks only the notifications of the tasks on screen — unrelated unread ones keep counting", async () => {
    const server = fakeServer([
      notification("a", TASK_A),
      notification("b", TASK_B),
      notification("elsewhere", OTHER_TASK),
      notification("channel", null),
    ]);
    const { badge } = mount(server, [{ taskId: TASK_A }, { taskId: TASK_B }]);

    await waitFor(() => expect(badge()).toBe(2));

    expect(server.fns.markTaskNotificationsRead).toHaveBeenCalledExactlyOnceWith([TASK_A, TASK_B]);
    expect(server.unread()).toEqual(["channel", "elsewhere"]);
  });

  it("keeps every notification in the history: they flip to read and are never removed", async () => {
    const server = fakeServer([notification("a", TASK_A), notification("old", TASK_A, true)]);
    const { qc, badge } = mount(server, [{ taskId: TASK_A }], { cachedList: server.state.map((n) => ({ ...n })) });

    await waitFor(() => expect(badge()).toBe(0));

    const cached = flattenNotificationPages(qc.getQueryData<NotificationPages>(qk.notifications));
    expect(cached.map((n) => [n.id, n.read]).sort()).toEqual([["a", true], ["old", true]]);
    expect(server.state).toHaveLength(2);
  });

  it("lowers the badge by exactly what the server marked, without waiting for a refetch", async () => {
    const server = fakeServer([notification("a", TASK_A), notification("keep1", null), notification("keep2", OTHER_TASK)]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 3, tasksUnreadCount: 3 });

    await markTaskNotificationsRead(server.api, qc, [TASK_A]);

    // No active observer, so nothing refetched: this is the optimistic step alone.
    // Every row read-by-tasks touches is a TASK_* notification, so the Tasks
    // badge falls by the same amount as the bell.
    expect(qc.getQueryData(qk.notificationsUnreadCount)).toEqual({ unreadCount: 2, tasksUnreadCount: 2 });
  });

  it("changes nothing and refetches nothing when the server had nothing to mark", async () => {
    const server = fakeServer([notification("keep", OTHER_TASK)]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 1 });

    await markTaskNotificationsRead(server.api, qc, [TASK_A]);

    expect(qc.getQueryData(qk.notificationsUnreadCount)).toEqual({ unreadCount: 1 });
    expect(qc.getQueryState(qk.notificationsUnreadCount)?.isInvalidated).toBe(false);
  });

  it("never takes the badge below zero", async () => {
    const server = fakeServer([notification("a", TASK_A), notification("a2", TASK_A)]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 1, tasksUnreadCount: 1 }); // stale-low cache

    await markTaskNotificationsRead(server.api, qc, [TASK_A]);

    // Optimistic -2 clamps at 0; the refetch then reads the server's own number.
    await waitFor(() =>
      expect(qc.getQueryData(qk.notificationsUnreadCount)).toEqual({ unreadCount: 0, tasksUnreadCount: 0 }),
    );
  });

  it("puts nothing in the cache and throws nothing when the server call fails — the notification is still unread", async () => {
    const server = fakeServer([notification("a", TASK_A)], { failMark: true });
    const { qc, badge } = mount(server, [{ taskId: TASK_A }], { cachedList: [notification("a", TASK_A)] });

    await waitFor(() => expect(server.fns.markTaskNotificationsRead).toHaveBeenCalled());
    await act(async () => {});

    expect(badge()).toBe(1);
    expect(server.unread()).toEqual(["a"]);
    expect(flattenNotificationPages(qc.getQueryData<NotificationPages>(qk.notifications))[0]?.read).toBe(false);
  });

  it("does not call the server when nothing is unread, or no task is on screen", async () => {
    const none = fakeServer([notification("done", TASK_A, true)]);
    mount(none, [{ taskId: TASK_A }]);
    await waitFor(() => expect(none.fns.notificationsUnreadCount).toHaveBeenCalled());
    await act(async () => {});
    expect(none.fns.markTaskNotificationsRead).not.toHaveBeenCalled();

    const empty = fakeServer([notification("a", TASK_A)]);
    mount(empty, []);
    await waitFor(() => expect(empty.fns.notificationsUnreadCount).toHaveBeenCalled());
    await act(async () => {});
    expect(empty.fns.markTaskNotificationsRead).not.toHaveBeenCalled();
  });

  it("marks a notification that arrives later for a task already on screen", async () => {
    const server = fakeServer([notification("unrelated", null)]);
    const { qc, badge } = mount(server, [{ taskId: TASK_A }]);
    await waitFor(() => expect(server.fns.markTaskNotificationsRead).toHaveBeenCalledTimes(1)); // 0 updated
    expect(badge()).toBe(1);

    // The realtime path: a new TASK notification lands, the count query is refetched.
    server.state.push(notification("fresh", TASK_A));
    await act(() => qc.invalidateQueries({ queryKey: qk.notificationsUnreadCount }));

    await waitFor(() => expect(server.unread()).toEqual(["unrelated"]));
    await waitFor(() => expect(badge()).toBe(1));
  });

  it("does not call again when the count only FALLS — including its own fall", async () => {
    const server = fakeServer([notification("a", TASK_A), notification("keep", null)]);
    const { badge } = mount(server, [{ taskId: TASK_A }]);
    await waitFor(() => expect(badge()).toBe(1));
    await act(async () => {});

    expect(server.fns.markTaskNotificationsRead).toHaveBeenCalledTimes(1);
  });

  it("asks again when the set of tasks on screen changes", async () => {
    const server = fakeServer([notification("b", TASK_B), notification("keep", null)]);
    const { view, badge } = mount(server, [{ taskId: TASK_A }]);
    await waitFor(() => expect(server.fns.markTaskNotificationsRead).toHaveBeenCalledTimes(1));
    expect(badge()).toBe(2);

    view.rerender({ tasks: [{ taskId: TASK_A }, { taskId: TASK_B }] });

    await waitFor(() => expect(badge()).toBe(1));
    expect(server.fns.markTaskNotificationsRead).toHaveBeenLastCalledWith([TASK_A, TASK_B]);
  });

  it("names each task once and splits a very long list into calls the server accepts", async () => {
    const server = fakeServer([notification("a", TASK_A)]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ids = Array.from({ length: 450 }, (_, i) => `018f0000-0000-7000-8000-${String(i).padStart(12, "0")}`);

    await markTaskNotificationsRead(server.api, qc, [...ids, ...ids, TASK_A]);

    const sizes = server.fns.markTaskNotificationsRead.mock.calls.map((c) => c[0].length);
    expect(sizes).toEqual([200, 200, 51]);
  });
});
