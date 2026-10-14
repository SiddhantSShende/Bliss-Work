/**
 * Opening a chat, a channel or a meeting marks THAT one's notifications as read, on
 * the SERVER, and nothing else — the same rule, and the same bookkeeping, the Tasks
 * section follows (useMarkTaskNotificationsRead.test.tsx).
 *
 * A fake server owns the rows and scopes the way the real endpoint does, and every
 * test starts with NO notification list cached unless it says so: the bell panel's
 * cache is empty until the bell has been opened, so a mark that relied on it would
 * silently do nothing for a chat opened first.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO, NotificationReadTarget } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { markTargetNotificationsRead, useMarkTargetNotificationsRead } from "./useMarkTargetNotificationsRead";
import { flattenNotificationPages, type NotificationPages } from "./notificationPages";

const CONV_A = "018f0000-0000-7000-8000-0000000000a1";
const CONV_B = "018f0000-0000-7000-8000-0000000000a2";
const CHAN_A = "018f0000-0000-7000-8000-0000000000b1";
const CHAN_B = "018f0000-0000-7000-8000-0000000000b2";
const CALL_A = "018f0000-0000-7000-8000-0000000000c1";
const CALL_B = "018f0000-0000-7000-8000-0000000000c2";
const TASK_A = "018f0000-0000-7000-8000-0000000000d1";

type Ids = Partial<Pick<NotificationDTO, "taskId" | "conversationId" | "channelId" | "callId">>;

function notification(id: string, kind: string, ids: Ids, read = false): NotificationDTO {
  return { id, kind, text: `n-${id}`, taskId: null, read, createdAt: "2026-08-01T09:05:00.000Z", ...ids };
}

/** The notification service: owns the rows, serves the count, marks by exactly one target. */
function fakeServer(rows: NotificationDTO[], opts: { failMark?: boolean } = {}) {
  const state = rows.map((n) => ({ ...n }));
  const fns = {
    notificationsUnreadCount: vi.fn(async () => ({
      unreadCount: state.filter((n) => !n.read).length,
      tasksUnreadCount: state.filter((n) => !n.read && n.kind.startsWith("TASK_")).length,
    })),
    markNotificationsReadByTarget: vi.fn(async (target: NotificationReadTarget) => {
      if (opts.failMark) throw new Error("boom");
      const [[field, id]] = Object.entries(target) as [[keyof Ids, string]];
      let updated = 0;
      for (const n of state) {
        if (!n.read && n[field] === id) {
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

const mixed = () =>
  fakeServer([
    notification("dm-a1", "DM_MESSAGE", { conversationId: CONV_A }),
    notification("dm-a2", "DM_MESSAGE", { conversationId: CONV_A }),
    notification("dm-b", "DM_MESSAGE", { conversationId: CONV_B }),
    notification("ch-a-msg", "CHANNEL_MESSAGE", { channelId: CHAN_A }),
    notification("ch-a-new", "CHANNEL_CREATED", { channelId: CHAN_A }),
    notification("ch-b-msg", "CHANNEL_MESSAGE", { channelId: CHAN_B }),
    notification("mtg-a-invite", "MEETING_INVITATION", { callId: CALL_A }),
    notification("mtg-a-start", "MEETING_STARTED", { callId: CALL_A }),
    notification("mtg-b", "MEETING_INVITATION", { callId: CALL_B }),
    notification("task", "TASK_ASSIGNED", { taskId: TASK_A }),
  ]);

type Field = "conversationId" | "channelId" | "callId";

function mount(
  server: ReturnType<typeof fakeServer>,
  initial: { field: Field; id: string | null },
  opts: { cachedList?: NotificationDTO[]; countLoaded?: number } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (opts.cachedList) {
    qc.setQueryData<NotificationPages>(qk.notifications, {
      pages: [{ items: opts.cachedList, nextCursor: null }],
      pageParams: [undefined],
    });
  }
  if (opts.countLoaded !== undefined) qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: opts.countLoaded });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    (p: { field: Field; id: string | null }) => {
      useMarkTargetNotificationsRead(server.api, p.field, p.id);
      // The bell, as AppShell runs it: an active observer of the same count.
      return useQuery({ queryKey: qk.notificationsUnreadCount, queryFn: () => server.api.notificationsUnreadCount() });
    },
    { wrapper, initialProps: initial },
  );
  const badge = () => view.result.current.data?.unreadCount;
  return { qc, view, badge };
}

describe("useMarkTargetNotificationsRead", () => {
  it.each([
    ["a chat", "conversationId", CONV_A, ["dm-a1", "dm-a2"]],
    ["a channel", "channelId", CHAN_A, ["ch-a-msg", "ch-a-new"]],
    ["a meeting", "callId", CALL_A, ["mtg-a-invite", "mtg-a-start"]],
  ] as const)("opening %s reads its notifications although the bell's list was never loaded", async (_l, field, id, read) => {
    const server = mixed();
    const { qc, badge } = mount(server, { field, id });
    expect(qc.getQueryData(qk.notifications)).toBeUndefined(); // the bell was never opened

    await waitFor(() => expect(badge()).toBe(10 - read.length));

    // Exactly the one id that was opened — never a list of them, never more than one kind.
    expect(server.fns.markNotificationsReadByTarget).toHaveBeenCalledExactlyOnceWith({ [field]: id });
    // Read on the server, not just in a cache — and everything else is still lit.
    const left = server.unread();
    for (const r of read) expect(left).not.toContain(r);
    expect(left).toHaveLength(10 - read.length);
  });

  it("leaves every other chat, channel, meeting and every task unread", async () => {
    const server = mixed();
    const { badge } = mount(server, { field: "conversationId", id: CONV_A });
    await waitFor(() => expect(badge()).toBe(8));
    expect(server.unread()).toEqual(
      ["ch-a-msg", "ch-a-new", "ch-b-msg", "dm-b", "mtg-a-invite", "mtg-a-start", "mtg-b", "task"].sort(),
    );
  });

  it("keeps every notification in the history: they flip to read and are never removed", async () => {
    const server = mixed();
    const { qc, badge } = mount(
      server,
      { field: "channelId", id: CHAN_A },
      { cachedList: server.state.map((n) => ({ ...n })) },
    );
    await waitFor(() => expect(badge()).toBe(8));

    const cached = flattenNotificationPages(qc.getQueryData<NotificationPages>(qk.notifications));
    expect(cached).toHaveLength(10);
    expect(cached.filter((n) => n.read).map((n) => n.id).sort()).toEqual(["ch-a-msg", "ch-a-new"]);
    expect(server.state).toHaveLength(10);
  });

  it("lowers the badge by exactly what the server marked, without waiting for a refetch", async () => {
    const server = mixed();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 10, tasksUnreadCount: 1 });

    await markTargetNotificationsRead(server.api, qc, "callId", CALL_A);

    // No active observer, so nothing refetched: this is the optimistic step alone.
    // A call/meeting target never touches the Tasks-scoped count.
    expect(qc.getQueryData(qk.notificationsUnreadCount)).toEqual({ unreadCount: 8, tasksUnreadCount: 1 });
  });

  it("changes nothing and refetches nothing when the server had nothing to mark", async () => {
    const server = mixed();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 10 });

    await markTargetNotificationsRead(server.api, qc, "conversationId", "018f0000-0000-7000-8000-0000000000ff");

    expect(qc.getQueryData(qk.notificationsUnreadCount)).toEqual({ unreadCount: 10 });
    expect(qc.getQueryState(qk.notificationsUnreadCount)?.isInvalidated).toBe(false);
  });

  it("puts nothing in the cache and throws nothing when the server call fails — they are still unread", async () => {
    const server = mixed();
    const failing = fakeServer(server.state, { failMark: true });
    const { qc, badge } = mount(failing, { field: "conversationId", id: CONV_A }, { cachedList: server.state });

    await waitFor(() => expect(failing.fns.markNotificationsReadByTarget).toHaveBeenCalled());
    await act(async () => {});

    // The count query is async too: wait for it rather than read it half-loaded.
    await waitFor(() => expect(badge()).toBe(10));
    const cached = flattenNotificationPages(qc.getQueryData<NotificationPages>(qk.notifications));
    expect(cached.every((n) => !n.read)).toBe(true);
  });

  it("is asked once per open, not on every render", async () => {
    const server = mixed();
    const { view, badge } = mount(server, { field: "conversationId", id: CONV_A });
    await waitFor(() => expect(badge()).toBe(8));

    view.rerender({ field: "conversationId", id: CONV_A });
    view.rerender({ field: "conversationId", id: CONV_A });
    await act(async () => {});

    expect(server.fns.markNotificationsReadByTarget).toHaveBeenCalledTimes(1);
  });

  it("reads the next conversation's notifications when the open one changes (the view is reused, not remounted)", async () => {
    const server = mixed();
    const { view, badge } = mount(server, { field: "conversationId", id: CONV_A });
    await waitFor(() => expect(badge()).toBe(8));

    view.rerender({ field: "conversationId", id: CONV_B });
    await waitFor(() => expect(badge()).toBe(7));

    expect(server.fns.markNotificationsReadByTarget).toHaveBeenLastCalledWith({ conversationId: CONV_B });
    expect(server.unread()).not.toContain("dm-b");
    expect(server.unread()).toContain("task");
  });

  it("does nothing while no chat is selected", async () => {
    const server = mixed();
    const { badge } = mount(server, { field: "conversationId", id: null });
    await waitFor(() => expect(badge()).toBe(10));
    await act(async () => {});
    expect(server.fns.markNotificationsReadByTarget).not.toHaveBeenCalled();
  });

  it("does not ask when the badge is already known to be zero", async () => {
    const server = fakeServer([notification("read", "DM_MESSAGE", { conversationId: CONV_A }, true)]);
    mount(server, { field: "conversationId", id: CONV_A }, { countLoaded: 0 });
    await act(async () => {});
    expect(server.fns.markNotificationsReadByTarget).not.toHaveBeenCalled();
  });

  it("does ask when the count has not loaded yet — a chat opened straight from a reload must still be read", async () => {
    const server = mixed();
    const { qc } = mount(server, { field: "conversationId", id: CONV_A });
    expect(qc.getQueryData(qk.notificationsUnreadCount)).toBeUndefined();
    await waitFor(() => expect(server.fns.markNotificationsReadByTarget).toHaveBeenCalledTimes(1));
  });
});
