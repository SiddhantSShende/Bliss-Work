/**
 * The notification flow end to end on the client: server → socket bridge → caches
 * → bell badge → panel → mark read → Tasks panel, against ONE fake notification
 * service that owns the rows. The bell and the panel read the same service, so
 * what these assert is that they cannot disagree:
 *
 *   state                       bell                    panel
 *   new unread                  badge                   listed, unread
 *   several unread              count                   all listed
 *   marked read                 count falls             still listed, read
 *   read-all                    badge gone              all still listed, read
 *   old / read                  no contribution         still listed
 *   nothing at all              no badge                "No notifications yet"
 *
 * The real WsEventBridge, NotificationsPanel, useNotificationPages and
 * useMarkTaskNotificationsRead are mounted; only the runtime (the service and the
 * socket) is faked.
 */
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type ApiClient, type NotificationDTO, type NotificationPageDTO, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { WsEventBridge } from "../lib/queryBridge";
import { useNotificationPages } from "../lib/useCursorPagination";
import { mergeNotificationFeeds } from "../lib/notificationPages";
import { unreadBadgeLabel } from "../lib/unreadNotificationCount";
import { useMarkTaskNotificationsRead } from "../lib/useMarkTaskNotificationsRead";
import { NotificationsPanel } from "./NotificationsPanel";

const ME = "11111111-1111-4111-8111-111111111111";
const ORG = "66666666-6666-4666-8666-666666666666";
const TASK_A = "018f0000-0000-7000-8000-0000000000a1";
const TASK_B = "018f0000-0000-7000-8000-0000000000a2";

/** The notification service: rows, paging, filter, count, mark-read — and the socket. */
const svc = vi.hoisted(() => ({
  rows: [] as unknown[],
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
}));
const rows = () => svc.rows as NotificationDTO[];

const api = {
  notificationPage: vi.fn(async (cursor?: string, limit = 10, read?: boolean): Promise<NotificationPageDTO> => {
    const all = rows()
      .filter((n) => read === undefined || n.read === read)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit).map((n) => ({ ...n }));
    return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
  }),
  notificationsUnreadCount: vi.fn(async () => ({ unreadCount: rows().filter((n) => !n.read).length })),
  markNotificationRead: vi.fn(async (id: string) => {
    for (const n of rows()) if (n.id === id) n.read = true;
  }),
  readAllNotifications: vi.fn(async () => {
    for (const n of rows()) n.read = true;
  }),
  markTaskNotificationsRead: vi.fn(async (taskIds: string[]) => {
    let updated = 0;
    for (const n of rows()) {
      if (!n.read && n.taskId && taskIds.includes(n.taskId)) {
        n.read = true;
        updated++;
      }
    }
    return { updated };
  }),
};

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    config: {},
    api,
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      on: (cb: (e: unknown, meta?: WsEventMeta) => void) => {
        svc.emit = cb;
        return () => {};
      },
    },
  }),
}));
vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) => sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }) }));

let seq = 0;
function row(text: string, over: Partial<NotificationDTO> = {}): NotificationDTO {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "TASK_ASSIGNED",
    text,
    taskId: null,
    read: false,
    createdAt: new Date(Date.UTC(2026, 8, 1, 12, seq)).toISOString(),
    ...over,
  };
}

/** A notification the service just created: it exists, and the socket announces it. */
function created(n: NotificationDTO) {
  rows().push(n);
  act(() => {
    svc.emit?.({
      type: EventType.NotificationCreated,
      eventId: crypto.randomUUID(),
      occurredAt: n.createdAt,
      orgId: ORG,
      notificationId: n.id,
      recipientId: ME,
      kind: n.kind,
      text: n.text,
      taskId: n.taskId ?? undefined,
      channelId: n.channelId ?? undefined,
      conversationId: n.conversationId ?? undefined,
      messageId: n.messageId ?? undefined,
      callId: n.callId ?? undefined,
    } as ServerEvent);
  });
}

/** Another session read everything (or one): the service says so over the socket. */
function readElsewhere(id?: string) {
  for (const n of rows()) {
    if (!id || n.id === id) n.read = true;
  }
  act(() => {
    svc.emit?.({
      type: EventType.NotificationRead,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      orgId: ORG,
      recipientId: ME,
      notificationId: id,
    } as ServerEvent);
  });
}

/** The shell's wiring of the bell and the panel — what AppShell does, in miniature. */
function Shell({ tasksOnScreen = [] }: { tasksOnScreen?: string[] }) {
  const [open, setOpen] = useState(false);
  const { data: count } = useQuery({ queryKey: qk.notificationsUnreadCount, queryFn: () => api.notificationsUnreadCount() });
  const unread = count?.unreadCount ?? 0;
  const unreadPages = useNotificationPages(api as unknown as ApiClient, open, false);
  const readPages = useNotificationPages(api as unknown as ApiClient, open, true);
  const notifications = mergeNotificationFeeds(unreadPages.data, readPages.data);
  const feed = (p: typeof unreadPages) => ({
    loading: p.isPending,
    failed: p.isError,
    hasNextPage: p.hasNextPage,
    isFetchingNextPage: p.isFetchingNextPage,
    loadMore: () => void p.fetchNextPage(),
  });
  useMarkTaskNotificationsRead(api as unknown as ApiClient, tasksOnScreen.map((taskId) => ({ taskId })));
  const label = unreadBadgeLabel(unread);
  return (
    <>
      <WsEventBridge />
      <button type="button" onClick={() => setOpen(true)}>
        Notifications{label ? ` (${label})` : ""}
      </button>
      <span data-testid="badge">{label ?? ""}</span>
      <NotificationsPanel
        open={open}
        onClose={() => setOpen(false)}
        notifications={notifications}
        unreadFeed={feed(unreadPages)}
        readFeed={feed(readPages)}
        unreadCount={unread}
        onRetry={() => {
          void unreadPages.refetch();
          void readPages.refetch();
        }}
      />
    </>
  );
}

function mount(props: { tasksOnScreen?: string[] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/tasks"]}>
        <Shell {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

const badge = () => screen.getByTestId("badge").textContent;
const open = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /^Notifications/ }));
const listed = () => screen.queryAllByRole("listitem").map((li) => li.textContent ?? "");
const rowOf = (text: string) => screen.getByText(text).closest("li")!;
const isRead = (text: string) => within(rowOf(text)).queryByRole("button", { name: "Mark read" }) === null;

beforeEach(() => {
  svc.rows = [];
  svc.emit = undefined;
  seq = 0;
  Object.values(api).forEach((f) => f.mockClear());
});

describe("notification flow: bell badge and panel share one source", () => {
  it("a new notification raises the badge and is listed, unread, when the panel is opened", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());
    expect(badge()).toBe("");

    created(row("Task assigned to you", { taskId: TASK_A }));

    await waitFor(() => expect(badge()).toBe("1"));
    await open(user);
    expect(await screen.findByText("Task assigned to you")).toBeInTheDocument();
    expect(isRead("Task assigned to you")).toBe(false);
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
  });

  it("several unread notifications: the badge counts them and the panel lists every one", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());

    for (const t of ["first", "second", "third"]) created(row(t));

    await waitFor(() => expect(badge()).toBe("3"));
    await open(user);
    await screen.findByText("third");
    expect(listed()).toHaveLength(3);
    for (const t of ["first", "second", "third"]) expect(isRead(t)).toBe(false);
  });

  it("marking one read lowers the badge and keeps the row listed, as read", async () => {
    const user = userEvent.setup();
    rows().push(row("keep me unread"), row("read me"));
    mount();
    await waitFor(() => expect(badge()).toBe("2"));

    await open(user);
    await user.click(within(await screen.findByText("read me").then((e) => e.closest("li")!)).getByRole("button", { name: "Mark read" }));

    await waitFor(() => expect(badge()).toBe("1"));
    expect(listed()).toHaveLength(2); // nothing was removed
    expect(isRead("read me")).toBe(true);
    expect(isRead("keep me unread")).toBe(false);
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("read-all (from any session) clears the badge and every row stays listed, as read", async () => {
    const user = userEvent.setup();
    rows().push(row("a"), row("b"), row("old", { read: true }));
    mount();
    await waitFor(() => expect(badge()).toBe("2"));
    await open(user);
    await screen.findByText("a");

    readElsewhere();

    await waitFor(() => expect(badge()).toBe(""));
    await waitFor(() => expect(isRead("a") && isRead("b")).toBe(true));
    expect(listed()).toHaveLength(3);
    expect(isRead("old")).toBe(true);
  });

  it("old, read notifications contribute nothing to the badge and are still in the history", async () => {
    const user = userEvent.setup();
    rows().push(row("ancient", { read: true, createdAt: "2025-01-01T00:00:00.000Z" }), row("fresh"));
    mount();
    await waitFor(() => expect(badge()).toBe("1"));

    await open(user);

    await screen.findByText("ancient");
    expect(isRead("ancient")).toBe(true);
    // Unread first, then the read history.
    expect(listed().map((t) => (t.includes("fresh") ? "fresh" : "ancient"))).toEqual(["fresh", "ancient"]);
  });

  it("a truly empty account: no badge, and the panel says there are no notifications", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());

    await open(user);

    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(badge()).toBe("");
  });

  it("reopening the app reloads the whole history from the server, read rows included", async () => {
    const user = userEvent.setup();
    rows().push(row("unread one"), row("read one", { read: true }));
    const first = mount();
    await waitFor(() => expect(badge()).toBe("1"));
    first.unmount();

    mount(); // a fresh client: nothing cached
    await waitFor(() => expect(badge()).toBe("1"));
    await open(user);

    expect(await screen.findByText("unread one")).toBeInTheDocument();
    expect(screen.getByText("read one")).toBeInTheDocument();
  });

  it("a notification that arrives while the panel is open joins the list at once, above the unread, without disturbing the rest", async () => {
    const user = userEvent.setup();
    rows().push(row("already here"), row("history", { read: true }));
    mount();
    await waitFor(() => expect(badge()).toBe("1"));
    await open(user);
    await screen.findByText("history");

    created(row("just arrived"));

    expect(await screen.findByText("just arrived")).toBeInTheDocument();
    await waitFor(() => expect(badge()).toBe("2"));
    expect(listed().map((t) => ["just arrived", "already here", "history"].find((k) => t.includes(k)))).toEqual([
      "just arrived",
      "already here",
      "history",
    ]);
    expect(isRead("history")).toBe(true);
    expect(isRead("just arrived")).toBe(false);
  });

  it("chat, channel and meeting notifications arriving live join the open panel without a refresh, each counted and clickable", async () => {
    const user = userEvent.setup();
    rows().push(row("Task completed by Piyush", { kind: "TASK_COMPLETED", read: true }));
    mount();
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());
    await open(user);
    await screen.findByText("Task completed by Piyush");

    const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    created(row("Priya Shah: Lunch at one?", { kind: "DM_MESSAGE", conversationId }));
    created(row("Priya Shah in #design: Review is ready", { kind: "CHANNEL_MESSAGE", channelId }));
    created(row("Meeting updated: Sprint planning", { kind: "MEETING_UPDATED", callId }));
    created(row("Meeting started: Sprint planning", { kind: "MEETING_STARTED", callId }));
    created(row("Meeting cancelled: Retro", { kind: "MEETING_CANCELLED" }));

    // Newest first, above the history, and all counted — no refresh of the panel.
    expect(await screen.findByText(/Meeting cancelled/)).toBeInTheDocument();
    await waitFor(() => expect(badge()).toBe("5"));
    expect(listed().map((t) => ["cancelled", "started", "updated", "Review is ready", "Lunch at one?", "Piyush"].find((k) => t.includes(k)))).toEqual([
      "cancelled", "started", "updated", "Review is ready", "Lunch at one?", "Piyush",
    ]);

    // Opening one marks it read through the existing path and lowers the badge by one.
    await user.click(screen.getByText(/Meeting started/));
    await waitFor(() => expect(badge()).toBe("4"));
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("the same notification arriving twice (a redelivered frame) is listed once and counted once", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());
    const n = row("once");

    created(n);
    act(() => {
      svc.emit?.({ type: EventType.NotificationCreated, eventId: crypto.randomUUID(), occurredAt: n.createdAt, orgId: ORG, notificationId: n.id, recipientId: ME, kind: n.kind, text: n.text } as ServerEvent);
    });

    await waitFor(() => expect(badge()).toBe("1"));
    await open(user);
    await screen.findByText("once");
    expect(listed()).toHaveLength(1);
  });
});

describe("notification flow: the Tasks panel reads only the notifications of the tasks on screen", () => {
  it("clears the badge for a task notification although the bell was never opened, and the notification stays in the history", async () => {
    const user = userEvent.setup();
    rows().push(row("Task assigned to you", { taskId: TASK_A }));
    mount({ tasksOnScreen: [TASK_A] });

    await waitFor(() => expect(api.markTaskNotificationsRead).toHaveBeenCalledWith([TASK_A]));
    await waitFor(() => expect(rows()[0]!.read).toBe(true));
    await waitFor(() => expect(badge()).toBe(""));
    expect(api.notificationPage).not.toHaveBeenCalled(); // the bell's list was never loaded

    await open(user);
    expect(await screen.findByText("Task assigned to you")).toBeInTheDocument();
    expect(isRead("Task assigned to you")).toBe(true);
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
  });

  it("leaves unrelated unread notifications unread and counted", async () => {
    const user = userEvent.setup();
    rows().push(
      row("Task assigned to you", { taskId: TASK_A }),
      row("About another task", { taskId: TASK_B }),
      row("Added to a channel", { kind: "CHANNEL_ADDED" }),
    );
    mount({ tasksOnScreen: [TASK_A] });

    await waitFor(() => expect(badge()).toBe("2"));
    await open(user);
    await screen.findByText("Added to a channel");

    expect(isRead("Task assigned to you")).toBe(true);
    expect(isRead("About another task")).toBe(false);
    expect(isRead("Added to a channel")).toBe(false);
    expect(listed()).toHaveLength(3);
  });

  it("reads a notification that arrives for a task already on screen", async () => {
    mount({ tasksOnScreen: [TASK_A] });
    await waitFor(() => expect(api.notificationsUnreadCount).toHaveBeenCalled());

    created(row("Task completed", { kind: "TASK_COMPLETED", taskId: TASK_A }));

    await waitFor(() => expect(rows().every((n) => n.read)).toBe(true));
    await waitFor(() => expect(badge()).toBe(""));
  });
});
