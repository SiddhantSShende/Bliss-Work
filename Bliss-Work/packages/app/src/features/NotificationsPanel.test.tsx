/**
 * Notification-center contract tests.
 *
 * The panel opens on the unread notifications and keeps read ones behind "View
 * read". Opening or closing it never changes read state: a notification becomes
 * read only when the user acts on it, and the badge is the server's unread count.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApiClient, NotificationDTO, NotificationPageDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { NotificationsPanel } from "./NotificationsPanel";
import { useState } from "react";
import { useNotificationPages } from "../lib/useCursorPagination";
import { flattenNotificationPages, mergeNotificationFeeds, addRealtimeNotification, type NotificationPages } from "../lib/notificationPages";
import { unreadBadgeLabel } from "../lib/unreadNotificationCount";

const api = {
  notifications: vi.fn(async () => [] as NotificationDTO[]),
  notificationPage: vi.fn(async (_cursor?: string, _limit?: number, _read?: boolean): Promise<NotificationPageDTO> => ({ items: [], nextCursor: null })),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
  markNotificationRead: vi.fn(async (_id: string) => {}),
  readAllNotifications: vi.fn(async () => {}),
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

beforeEach(() => {
  api.notifications.mockReset().mockResolvedValue([]);
  api.notificationPage.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  api.notificationsUnreadCount.mockReset().mockResolvedValue({ unreadCount: 0 });
  api.markNotificationRead.mockReset().mockResolvedValue(undefined);
  api.readAllNotifications.mockReset().mockResolvedValue(undefined);
});

const notification = (
  id: string,
  kind: NotificationDTO["kind"] = "TASK_COMPLETED",
  taskId: string | null = "018f0000-0000-7000-8000-0000000000a1",
  channelId: string | null = null,
  conversationId: string | null = null,
  read = false,
  callId: string | null = null,
): NotificationDTO => ({
  id,
  kind,
  text: `Task ${id} completed`,
  taskId,
  channelId,
  conversationId,
  callId,
  read,
  createdAt: "2026-08-01T09:05:00.000Z",
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A server that honours the `read` filter and pages by cursor, like the real
 *  endpoint: `unread` / `read` are lists of pages, newest first. */
function serve(unread: NotificationDTO[][], read: NotificationDTO[][] = []) {
  api.notificationPage.mockImplementation(async (cursor, _limit, wantRead) => {
    const pages = wantRead ? read : unread;
    const index = cursor ? Number(cursor.split(":")[1]) : 0;
    return {
      items: pages[index] ?? [],
      nextCursor: index + 1 < pages.length ? `${wantRead ? "r" : "u"}:${index + 1}` : null,
    };
  });
}
const many = (prefix: string, n: number, kind: NotificationDTO["kind"], read: boolean) =>
  Array.from({ length: n }, (_, i) => notification(`${prefix}${i}`, kind, null, null, null, read));

function Harness({ open = false }: { open?: boolean }) {
  const [isOpen, setIsOpen] = useState(open);
  const unreadPages = useNotificationPages(api as unknown as ApiClient, isOpen, false);
  const readPages = useNotificationPages(api as unknown as ApiClient, isOpen, true);
  const notifications = mergeNotificationFeeds(unreadPages.data, readPages.data);
  const feed = (pages: typeof unreadPages) => ({
    loading: pages.isPending,
    hasNextPage: pages.hasNextPage,
    isFetchingNextPage: pages.isFetchingNextPage,
    loadMore: () => void pages.fetchNextPage(),
  });
  const { data: unreadCount } = useQuery({
    queryKey: qk.notificationsUnreadCount,
    queryFn: () => api.notificationsUnreadCount(),
  });
  const location = useLocation();

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open notifications
      </button>
      <NotificationsPanel
        open={isOpen}
        onClose={() => setIsOpen(false)}
        notifications={notifications}
        unreadFeed={feed(unreadPages)}
        readFeed={feed(readPages)}
      />
      <output data-testid="unread-count">{unreadCount?.unreadCount ?? ""}</output>
      <output data-testid="location">{location.pathname}</output>
    </>
  );
}

function setup(list: NotificationDTO[] | null, cachedCount: number | null, open = false, nextCursor: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (list) {
    qc.setQueryData<NotificationPages>(qk.notifications, {
      pages: [{ items: list, nextCursor }],
      pageParams: [undefined],
    });
  }
  if (cachedCount !== null) qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: cachedCount });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(<Harness open={open} />, { wrapper });
  const badge = () => qc.getQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount)?.unreadCount;
  return { badge, view, qc };
}

describe("NotificationsPanel", () => {
  const openBell = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /Open notifications/i }));

  it("shows unread notifications by default and does not mark them read on open", async () => {
    const user = userEvent.setup();
    const { badge } = setup([notification("n1"), notification("n2")], 2);
    await openBell(user);

    expect(screen.getByText("Task n1 completed")).toBeInTheDocument();
    expect(screen.getByText("Task n2 completed")).toBeInTheDocument();
    expect(api.readAllNotifications).not.toHaveBeenCalled();
    expect(badge()).toBe(2);
  });

  it("keeps the badge and unread rows after the bell is opened and closed", async () => {
    const user = userEvent.setup();
    const { badge } = setup([notification("loaded-one")], 87);
    await openBell(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Task loaded-one completed")).not.toBeInTheDocument());
    await openBell(user);

    expect(api.readAllNotifications).not.toHaveBeenCalled();
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(badge()).toBe(87);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("87");
    expect(screen.getByText("Task loaded-one completed")).toBeInTheDocument();
  });

  it("lowers the badge by one when a notification is explicitly marked read", async () => {
    const user = userEvent.setup();
    api.notificationsUnreadCount.mockResolvedValue({ unreadCount: 1 });
    const { badge } = setup([notification("n1"), notification("n2")], 2);
    await openBell(user);
    await user.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(badge()).toBe(1);
    // The other row is untouched and still unread.
    expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("unread-count")).toHaveTextContent("1"));
  });

  it("keeps a row read after refresh: the server's read state, not the cache, decides", async () => {
    const user = userEvent.setup();
    // A tiny stateful server behind the mocked API, shared by both mounts.
    const rows = [notification("keep-unread"), notification("will-read")];
    const isRead = new Set<string>();
    api.markNotificationRead.mockImplementation(async (id) => void isRead.add(id));
    api.notificationsUnreadCount.mockImplementation(async () => ({
      unreadCount: rows.filter((n) => !isRead.has(n.id)).length,
    }));
    api.notificationPage.mockImplementation(async (_cursor, _limit, wantRead) => ({
      items: rows.filter((n) => isRead.has(n.id) === Boolean(wantRead)).map((n) => ({ ...n, read: isRead.has(n.id) })),
      nextCursor: null,
    }));

    const first = setup(null, 2);
    await openBell(user);
    const row = (await screen.findByText("Task will-read completed")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(isRead.has("will-read")).toBe(true));
    first.view.unmount();

    // "Refresh": a brand-new client with an empty cache.
    setup(null, null);
    await waitFor(() => expect(screen.getByTestId("unread-count")).toHaveTextContent("1"));
    await openBell(user);
    expect(await screen.findByText("Task keep-unread completed")).toBeInTheDocument();
    expect(screen.queryByText("Task will-read completed")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "View read (1)" }));
    expect(screen.getByText("Task will-read completed")).toBeInTheDocument();
  });

  it("hides read notifications behind View read, and offers nothing when there are none", async () => {
    const user = userEvent.setup();
    setup([notification("new1"), notification("old1", "TASK_COMPLETED", null, null, null, true)], 1);
    await openBell(user);

    expect(screen.getByText("Task new1 completed")).toBeInTheDocument();
    expect(screen.queryByText("Task old1 completed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View read (1)" }));
    expect(screen.getByText("Task old1 completed")).toBeInTheDocument();
    expect(screen.getByText("Task new1 completed")).toBeInTheDocument();
    // Never twice: one row per id across unread + read.
    expect(screen.getAllByText(/Task (new1|old1) completed/)).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Hide read" }));
    expect(screen.queryByText("Task old1 completed")).not.toBeInTheDocument();
    expect(screen.getAllByText("Task new1 completed")).toHaveLength(1);
  });

  it("has no View read control when nothing is read", async () => {
    const user = userEvent.setup();
    setup([notification("n1")], 1);
    await openBell(user);
    expect(screen.queryByRole("button", { name: /View read/ })).not.toBeInTheDocument();
  });

  it("shows every kind together, read and unread alike, and still shows task notifications", async () => {
    const user = userEvent.setup();
    setup(
      [
        { ...notification("dm", "DM_MESSAGE", null), text: "Ann: hi" },
        { ...notification("meet", "MEETING_INVITATION", null), text: "Invited to Standup" },
        { ...notification("chan", "CHANNEL_ADDED", null), text: "Added to #general" },
        notification("task", "TASK_ASSIGNED"),
        notification("oldtask", "TASK_COMPLETED", null, null, null, true),
      ],
      4,
    );
    await openBell(user);

    for (const text of ["hi", "Invited to Standup", "Added to #general", "Task task completed"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: /View read/ }));
    expect(screen.getByText("Task oldtask completed")).toBeInTheDocument();
  });

  it("shows the generic empty state when there are no notifications", async () => {
    const user = userEvent.setup();
    setup([], 0);
    await openBell(user);

    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
    expect(screen.getByText("Updates and activity will show up here.")).toBeInTheDocument();
    expect(screen.queryByText(/Task updates/)).not.toBeInTheDocument();
  });

  it("says you're caught up, pointing at View read, when only read notifications exist", async () => {
    const user = userEvent.setup();
    setup([notification("old1", "TASK_COMPLETED", null, null, null, true)], 0);
    await openBell(user);

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View read (1)" })).toBeInTheDocument();
  });

  it.each([
    "TASK_ACKNOWLEDGED",
    "TASK_COMPLETED",
    "TASK_IGNORED",
    "TASK_LEFT",
    "TASK_WITHDRAWN",
  ] as const)("opens task details for %s after a row click", async (kind) => {
    const user = userEvent.setup();
    const taskId = "018f0000-0000-7000-8000-0000000000b2";
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("task-notice", kind, taskId, null, null, false)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task task-notice completed/ }));

    expect(api.markNotificationRead).toHaveBeenCalledWith("task-notice");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/mail/task/${taskId}`));
  });

  it("opens the channel from a channel-added notification after a row click", async () => {
    const user = userEvent.setup();
    const channelId = "018f0000-0000-7000-8000-0000000000c3";
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("channel-notice", "CHANNEL_ADDED", null, channelId, null, false)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task channel-notice completed/ }));

    expect(api.markNotificationRead).toHaveBeenCalledWith("channel-notice");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/channels/${channelId}`));
  });

  it.each([
    ["CHANNEL_ADDED", null, null, "/app/channels"],
    ["TASK_COMPLETED", null, null, "/app/tasks/allocated"],
    ["DM_MESSAGE", null, null, "/app/chats"],
  ] as const)("uses the section fallback for %s without destination metadata", async (kind, taskId, channelId, path) => {
    const user = userEvent.setup();
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("old-notice", kind, taskId, channelId, null, false)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task old-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(path));
  });

  it("opens a direct-message thread from a DM notification", async () => {
    const user = userEvent.setup();
    const conversationId = "018f0000-0000-7000-8000-0000000000d4";
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("dm-notice", "DM_MESSAGE", null, null, conversationId, false)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task dm-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/chats/${conversationId}`));
  });

  it("opens a meeting from its persisted call ID", async () => {
    const user = userEvent.setup();
    const callId = "018f0000-0000-7000-8000-0000000000e5";
    setup([notification("meeting-notice", "MEETING_INVITATION", null, null, null, false, callId)], 0, true);

    await user.click(screen.getByRole("button", { name: /Task meeting-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/meetings/${callId}`));
  });

  it("requests the first 10 UNREAD notifications, filtered by the server", async () => {
    const user = userEvent.setup();
    serve([many("n", 10, "DM_MESSAGE", false), []]);
    setup(null, 18);

    await openBell(user);
    await waitFor(() => expect(api.notificationPage).toHaveBeenCalledWith(undefined, 10, false));
    expect(await screen.findByText("Task n9 completed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("loads and appends the next unread page without dropping or duplicating IDs", async () => {
    const user = userEvent.setup();
    const first = many("n", 10, "DM_MESSAGE", false);
    serve([first, [first[9]!, ...many("m", 9, "CHANNEL_MESSAGE", false)]]);
    setup(null, 20);

    await openBell(user);
    await screen.findByText("Task n0 completed");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Task m8 completed")).toBeInTheDocument();
    expect(api.notificationPage).toHaveBeenCalledWith("u:1", 10, false);
    expect(screen.getAllByText("Task n9 completed")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("disables Load more and shows a loading state while the next page is in flight", async () => {
    const user = userEvent.setup();
    let resolveNext!: (page: NotificationPageDTO) => void;
    api.notificationPage.mockImplementation((cursor, _limit, wantRead) => {
      if (wantRead) return Promise.resolve({ items: [], nextCursor: null });
      if (!cursor) return Promise.resolve({ items: many("busy", 10, "DM_MESSAGE", false), nextCursor: "u:1" });
      return new Promise((resolve) => { resolveNext = resolve; });
    });
    setup(null, 12);

    await openBell(user);
    await screen.findByText("Task busy0 completed");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("button", { name: "Loading…" })).toBeDisabled();
    await act(async () => resolveNext({ items: [], nextCursor: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load more|Loading/i })).not.toBeInTheDocument());
  });

  describe("unread notifications behind read ones", () => {
    // The old client-side split saw only read rows on the first loaded page and
    // said "all caught up" while unread ones waited on a later page. The
    // server-side filter makes the unread feed's first page unread rows only.
    const readNewest = many("r", 10, "DM_MESSAGE", true);
    const unreadOldest = [
      { ...notification("u-task", "TASK_ASSIGNED"), text: "Assigned a task" },
      { ...notification("u-meet", "MEETING_INVITATION", null), text: "Invited to Standup" },
    ];

    it("shows the unread ones immediately, without loading unrelated read pages", async () => {
      const user = userEvent.setup();
      serve([unreadOldest], [readNewest, many("older", 10, "DM_MESSAGE", true)]);
      setup(null, 2);

      await openBell(user);

      expect(await screen.findByText("Assigned a task")).toBeInTheDocument();
      expect(screen.getByText("Invited to Standup")).toBeInTheDocument();
      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
      expect(screen.queryByText("Task r0 completed")).not.toBeInTheDocument();
      // Only the first page of each feed was ever requested; read rows stay behind View read.
      expect(api.notificationPage).not.toHaveBeenCalledWith("r:1", expect.anything(), true);
      expect(api.notificationPage).not.toHaveBeenCalledWith("u:1", expect.anything(), false);
    });

    it("does not claim 'all caught up' while the unread feed has not answered", async () => {
      const user = userEvent.setup();
      api.notificationPage.mockImplementation((_c, _l, wantRead) =>
        wantRead ? Promise.resolve({ items: readNewest, nextCursor: null }) : new Promise(() => {}),
      );
      setup(null, 2);

      await openBell(user);
      await screen.findByRole("button", { name: /View read/ });

      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
      expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
    });

    it("keeps paging the unread feed when locally-read rows hide the whole loaded page", async () => {
      const user = userEvent.setup();
      const stale = many("stale", 10, "DM_MESSAGE", true); // flipped read, still in the unread cache
      serve([stale, unreadOldest]);
      setup(null, 2);

      await openBell(user);

      expect(await screen.findByText("Assigned a task")).toBeInTheDocument();
      expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    });

    it("reveals the read feed on View read with no duplicates, and hides it again", async () => {
      const user = userEvent.setup();
      // The same row is in both feeds (marked read here, not refetched yet).
      const flipped = { ...notification("u-task", "TASK_ASSIGNED"), text: "Assigned a task", read: true };
      serve([[flipped, unreadOldest[1]!]], [[flipped, ...readNewest.slice(0, 2)]]);
      setup(null, 1);

      await openBell(user);
      await screen.findByText("Invited to Standup");
      await user.click(screen.getByRole("button", { name: "View read (3)" }));

      expect(screen.getAllByText("Assigned a task")).toHaveLength(1);
      expect(screen.getAllByText("Invited to Standup")).toHaveLength(1);
      expect(screen.getByText("Task r0 completed")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Hide read" }));
      expect(screen.queryByText("Task r0 completed")).not.toBeInTheDocument();
      expect(screen.getAllByText("Invited to Standup")).toHaveLength(1);
    });

    it("caches the unread feed under qk.notifications and the read feed under qk.notificationsRead", async () => {
      const user = userEvent.setup();
      serve([unreadOldest], [readNewest.slice(0, 3)]);
      const { qc } = setup(null, 2);

      await openBell(user);
      await screen.findByText("Assigned a task");
      await screen.findByRole("button", { name: "View read (3)" });

      const ids = (key: readonly string[]) =>
        flattenNotificationPages(qc.getQueryData<NotificationPages>(key)).map((n) => n.id).sort();
      expect(ids(qk.notifications)).toEqual(["u-meet", "u-task"]);
      expect(ids(qk.notificationsRead)).toEqual(["r0", "r1", "r2"]);
    });

    it("renders a row marked read locally exactly once, as read, in both views", async () => {
      const user = userEvent.setup();
      serve([unreadOldest], [readNewest.slice(0, 2)]);
      setup(null, 2);

      await openBell(user);
      await screen.findByText("Assigned a task");
      await user.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

      // Gone from the unread view…
      await waitFor(() => expect(screen.queryByText("Assigned a task")).not.toBeInTheDocument());
      // …and present exactly once under View read, alongside the already-read rows.
      await user.click(screen.getByRole("button", { name: /View read/ }));
      expect(screen.getAllByText("Assigned a task")).toHaveLength(1);
      expect(screen.getAllByText("Invited to Standup")).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Hide read" }));
      await user.click(screen.getByRole("button", { name: /View read/ }));
      expect(screen.getAllByText("Assigned a task")).toHaveLength(1);
    });

    it("marks the read count as a lower bound while more read pages exist", async () => {
      const user = userEvent.setup();
      serve([[]], [readNewest, many("older", 10, "DM_MESSAGE", true)]);
      setup(null, 0);

      await openBell(user);

      expect(await screen.findByRole("button", { name: "View read (10+)" })).toBeInTheDocument();
      expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    });
  });

  it("keeps the badge tied to the total server unread count, not loaded pages", () => {
    setup(Array.from({ length: 10 }, (_, index) => notification(`read${index}`, "DM_MESSAGE", null, null, null, true)), 124);
    expect(screen.getByTestId("unread-count")).toHaveTextContent("124");
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(7)).toBe("7");
    expect(unreadBadgeLabel(100)).toBe("99+");
  });

  it("adds realtime notifications once and increments the backend-count cache", () => {
    const { qc, badge } = setup([notification("existing")], 4);
    const incoming = notification("live", "CHANNEL_MESSAGE", null);

    addRealtimeNotification(qc, incoming);
    addRealtimeNotification(qc, incoming);

    expect(badge()).toBe(5);
    expect(flattenNotificationPages(qc.getQueryData(qk.notifications))).toHaveLength(2);
  });

  it("shows a new notification in the open panel and raises the badge", async () => {
    const user = userEvent.setup();
    const { qc, badge } = setup([notification("existing")], 1, true);
    expect(screen.getByText("Task existing completed")).toBeInTheDocument();

    act(() => {
      addRealtimeNotification(qc, { ...notification("fresh", "CHANNEL_MESSAGE", null), text: "Ann in #dev: ping", createdAt: "2026-08-01T10:00:00.000Z" });
    });

    expect(badge()).toBe(2);
    expect(await screen.findByText("ping")).toBeInTheDocument();
    expect(screen.getByText("Task existing completed")).toBeInTheDocument();
  });

  it("renders every currently persisted notification kind", async () => {
    const user = userEvent.setup();
    const kinds: NotificationDTO["kind"][] = [
      "TASK_ASSIGNED", "TASK_ACKNOWLEDGED", "TASK_COMPLETED", "TASK_IGNORED", "TASK_LEFT", "TASK_WITHDRAWN",
      "CHANNEL_ADDED", "DM_MESSAGE", "CHANNEL_MESSAGE",
      "CHANNEL_CREATED", "MEETING_SCHEDULED", "MEETING_INVITATION",
    ];
    setup(kinds.map((kind, index) => notification(`kind-${index}`, kind, null, null, null, false)), 0, true);

    for (let index = 0; index < kinds.length; index++) {
      expect(screen.getByText(`Task kind-${index} completed`)).toBeInTheDocument();
    }
  });

  it("separates message sender and channel attribution from the preview", () => {
    setup([
      { ...notification("dm-text", "DM_MESSAGE", null), text: "Mayank: hello" },
      { ...notification("channel-text", "CHANNEL_MESSAGE", null), text: "Mayank in #Engineering: hello everyone" },
    ], 0, true);

    expect(screen.getAllByText("Mayank")).toHaveLength(2);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("Engineering", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("hello everyone")).toBeInTheDocument();
  });
});
