/**
 * Notification-center contract tests.
 *
 * The bell's job is to clear the server-side unread count when the panel opens,
 * while preserving the row click-through logic for the notifications already in
 * the list. This suite intentionally matches that real behavior rather than the
 * outdated "mark read per-row on open" logic.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApiClient, NotificationDTO, NotificationPageDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { NotificationsPanel } from "./NotificationsPanel";
import { useState } from "react";
import { useNotificationPages } from "../lib/useCursorPagination";
import { flattenNotificationPages, addRealtimeNotification, type NotificationPages } from "../lib/notificationPages";
import { unreadBadgeLabel } from "../lib/unreadNotificationCount";

const api = {
  notifications: vi.fn(async () => [] as NotificationDTO[]),
  notificationPage: vi.fn(async (_cursor?: string, _limit?: number): Promise<NotificationPageDTO> => ({ items: [], nextCursor: null })),
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

function Harness({ open = false }: { open?: boolean }) {
  const [isOpen, setIsOpen] = useState(open);
  const pages = useNotificationPages(api as unknown as ApiClient, isOpen);
  const notifications = flattenNotificationPages(pages.data);
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
        hasNextPage={pages.hasNextPage}
        isFetchingNextPage={pages.isFetchingNextPage}
        onLoadMore={() => void pages.fetchNextPage()}
      />
      <output data-testid="unread-count">{unreadCount?.unreadCount ?? ""}</output>
      <output data-testid="location">{location.pathname}</output>
    </>
  );
}

function setup(list: NotificationDTO[] | null, cachedCount: number, open = false, nextCursor: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (list) {
    qc.setQueryData<NotificationPages>(qk.notifications, {
      pages: [{ items: list, nextCursor }],
      pageParams: [undefined],
    });
  }
  qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: cachedCount });
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
  it("marks every unread notification read when the panel opens", async () => {
    const inFlight = deferred();
    const user = userEvent.setup();
    api.markNotificationRead.mockReturnValue(inFlight.promise);
    api.readAllNotifications.mockReturnValue(inFlight.promise);
    api.notificationsUnreadCount.mockReturnValue(new Promise(() => {}));

    const { badge } = setup([notification("n1"), notification("n2")], 2);
    await user.click(screen.getByRole("button", { name: /Open notifications/i }));

    await waitFor(() => expect(api.readAllNotifications).toHaveBeenCalledTimes(1));
    expect(badge()).toBe(0);
    expect(screen.getByText("Task n1 completed")).toBeInTheDocument();
    expect(screen.getByText("Task n2 completed")).toBeInTheDocument();

    await act(async () => inFlight.resolve());
    expect(badge()).toBe(0);
  });

  it("calls server-side read-all on open even when unread rows are outside the loaded page", async () => {
    const user = userEvent.setup();
    setup([notification("loaded-one")], 87);

    await user.click(screen.getByRole("button", { name: /Open notifications/i }));

    await waitFor(() => expect(api.readAllNotifications).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");
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
    setup([notification("task-notice", kind, taskId, null, null, true)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task task-notice completed/ }));

    expect(api.markNotificationRead).toHaveBeenCalledWith("task-notice");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/mail/task/${taskId}`));
  });

  it("opens the channel from a channel-added notification after a row click", async () => {
    const user = userEvent.setup();
    const channelId = "018f0000-0000-7000-8000-0000000000c3";
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("channel-notice", "CHANNEL_ADDED", null, channelId, null, true)], 1, true);

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
    setup([notification("old-notice", kind, taskId, channelId, null, true)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task old-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(path));
  });

  it("opens a direct-message thread from a DM notification", async () => {
    const user = userEvent.setup();
    const conversationId = "018f0000-0000-7000-8000-0000000000d4";
    api.markNotificationRead.mockReset().mockResolvedValue(undefined);
    setup([notification("dm-notice", "DM_MESSAGE", null, null, conversationId, true)], 1, true);

    await user.click(screen.getByRole("button", { name: /Task dm-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/chats/${conversationId}`));
  });

  it("opens a meeting from its persisted call ID", async () => {
    const user = userEvent.setup();
    const callId = "018f0000-0000-7000-8000-0000000000e5";
    setup([notification("meeting-notice", "MEETING_INVITATION", null, null, null, true, callId)], 0, true);

    await user.click(screen.getByRole("button", { name: /Task meeting-notice completed/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/app/meetings/${callId}`));
  });

  it("requests only the first 10 notifications from the backend", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 10 }, (_, index) => notification(`n${index}`, "DM_MESSAGE", null));
    api.notificationPage.mockResolvedValue({ items: firstPage, nextCursor: "next-page" });
    setup(null, 18);

    await user.click(screen.getByRole("button", { name: /Open notifications/i }));
    await waitFor(() => expect(api.notificationPage).toHaveBeenCalledWith(undefined, 10));
    expect(await screen.findByText("Task n9 completed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("loads and appends the next 10 without dropping or duplicating existing IDs", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 10 }, (_, index) => notification(`n${index}`, "DM_MESSAGE", null));
    const nextPage = [
      firstPage[9]!,
      ...Array.from({ length: 9 }, (_, index) => notification(`n${index + 10}`, "CHANNEL_MESSAGE", null)),
    ];
    api.notificationPage
      .mockResolvedValueOnce({ items: firstPage, nextCursor: "cursor-10" })
      .mockResolvedValueOnce({ items: nextPage, nextCursor: null });
    setup(null, 20);

    await user.click(screen.getByRole("button", { name: /Open notifications/i }));
    await screen.findByText("Task n0 completed");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Task n18 completed")).toBeInTheDocument();
    expect(api.notificationPage).toHaveBeenNthCalledWith(2, "cursor-10", 10);
    expect(screen.getByText("Task n0 completed")).toBeInTheDocument();
    expect(screen.getAllByText("Task n9 completed")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("disables Load more and shows a loading state while the next page is in flight", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 10 }, (_, index) => notification(`busy${index}`, "DM_MESSAGE", null));
    let resolveNext!: (page: NotificationPageDTO) => void;
    api.notificationPage
      .mockResolvedValueOnce({ items: firstPage, nextCursor: "cursor-next" })
      .mockReturnValueOnce(new Promise((resolve) => { resolveNext = resolve; }));
    setup(null, 12);

    await user.click(screen.getByRole("button", { name: /Open notifications/i }));
    await screen.findByText("Task busy0 completed");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(api.notificationPage).toHaveBeenCalledTimes(2);
    await act(async () => resolveNext({ items: [], nextCursor: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load more|Loading/i })).not.toBeInTheDocument());
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

  it("renders every currently persisted notification kind", async () => {
    const user = userEvent.setup();
    const kinds: NotificationDTO["kind"][] = [
      "TASK_ASSIGNED", "TASK_ACKNOWLEDGED", "TASK_COMPLETED", "TASK_IGNORED", "TASK_LEFT", "TASK_WITHDRAWN",
      "CHANNEL_ADDED", "DM_MESSAGE", "CHANNEL_MESSAGE",
      "CHANNEL_CREATED", "MEETING_SCHEDULED", "MEETING_INVITATION",
    ];
    setup(kinds.map((kind, index) => notification(`kind-${index}`, kind, null, null, null, true)), 0, true);

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
