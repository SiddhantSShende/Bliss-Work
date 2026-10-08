/**
 * The bell is the user's GLOBAL notification history — task, chat, channel and
 * meeting/call notifications (and any kind a newer server adds) in one list.
 *
 * What is real here: the data is a captured body of GET /api/v1/notifications from the
 * running services (shared/__fixtures__/notifications.allkinds.live.json — real task-svc
 * and messaging-svc calls, persisted by the current notification-svc), the client is the
 * real ApiClient with its strict zod schema, and the cache plumbing, hooks, panel and the
 * "opening a task marks its notifications read" helper are the app's own. Only the socket
 * to the network is replaced, by a small in-memory server that answers like notification-svc
 * does (read filter, unread-count, mark-read, read-by-tasks scoped to task ids).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, type NotificationDTO } from "@taskboard/shared";
import live from "../../../shared/src/api/__fixtures__/notifications.allkinds.live.json";
import { qk } from "../lib/queryKeys";
import { useNotificationPages } from "../lib/useCursorPagination";
import { mergeNotificationFeeds } from "../lib/notificationPages";
import { markTaskNotificationsRead } from "../lib/useMarkTaskNotificationsRead";
import { NotificationsPanel } from "./NotificationsPanel";

const api = new ApiClient({ notificationBase: "http://notif.test", getToken: async () => "tok" } as never);
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

const real = live.items as NotificationDTO[];
const byKind = (k: string) => real.find((n) => n.kind === k)!;
// The live DM names no sender and the live channel message no channel ("New message: …",
// "Alloc Owner in a channel: …"), and neither list is cached here — so the panel draws
// the fallbacks. Message rows show a sender line, never the message text.
const DM_LINE = "Someone";
const CHANNEL_LINE = "Alloc Owner · a channel";
const shownText = (n: NotificationDTO) =>
  n.kind === "DM_MESSAGE" ? DM_LINE : n.kind === "CHANNEL_MESSAGE" ? CHANNEL_LINE : n.text.split(": ").at(-1)!;
// A kind no build of the client has heard of, newer than everything else.
const FUTURE: NotificationDTO = {
  ...byKind("DM_MESSAGE"),
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "CALL_MISSED",
  text: "Missed call from Priya",
  conversationId: null,
  createdAt: "2099-01-01T00:00:00.000Z",
};
// A task the user has open, with two notifications of its own, and a second task.
const OPEN_TASK = byKind("TASK_ASSIGNED").taskId!;
const TASK_ACK: NotificationDTO = { ...byKind("TASK_ASSIGNED"), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "TASK_ACKNOWLEDGED", text: "Task acknowledged by Divya", createdAt: "2026-01-01T00:00:00.000Z" };
const OTHER_TASK: NotificationDTO = { ...TASK_ACK, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", text: "Task completed by Piyush", kind: "TASK_COMPLETED", createdAt: "2026-01-02T00:00:00.000Z" };

let rows: NotificationDTO[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const newestFirst = (list: NotificationDTO[]) => [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

beforeEach(() => {
  rows = structuredClone([...real, FUTURE, TASK_ACK, OTHER_TASK]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/unread-count")) return json({ unreadCount: rows.filter((n) => !n.read).length });
      if (path.endsWith("/read-by-tasks")) {
        const ids = new Set((JSON.parse(String(init?.body)) as { taskIds: string[] }).taskIds);
        const hit = rows.filter((n) => !n.read && n.taskId && ids.has(n.taskId));
        hit.forEach((n) => (n.read = true));
        return json({ updated: hit.length });
      }
      const one = path.match(/\/notifications\/([^/]+)\/read$/);
      if (one) {
        rows.filter((n) => n.id === one[1]).forEach((n) => (n.read = true));
        return json({});
      }
      const wantRead = url.searchParams.get("read");
      const items = newestFirst(rows).filter((n) => wantRead === null || n.read === (wantRead === "true"));
      return json({ items: items.slice(0, Number(url.searchParams.get("limit") ?? 50)), nextCursor: null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Harness() {
  const [open, setOpen] = useState(false);
  const unreadPages = useNotificationPages(api, open, false);
  const readPages = useNotificationPages(api, open, true);
  const feed = (p: typeof unreadPages) => ({
    loading: p.isPending,
    failed: p.isError,
    hasNextPage: p.hasNextPage,
    isFetchingNextPage: p.isFetchingNextPage,
    loadMore: () => void p.fetchNextPage(),
  });
  const { data: count } = useQuery({ queryKey: qk.notificationsUnreadCount, queryFn: () => api.notificationsUnreadCount() });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open notifications</button>
      <NotificationsPanel
        open={open}
        onClose={() => setOpen(false)}
        notifications={mergeNotificationFeeds(unreadPages.data, readPages.data)}
        unreadFeed={feed(unreadPages)}
        readFeed={feed(readPages)}
        unreadCount={count?.unreadCount ?? 0}
      />
      <output data-testid="badge">{count?.unreadCount ?? ""}</output>
    </>
  );
}

async function openPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app"]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Open notifications/i }));
  await screen.findByText(byKind("TASK_ASSIGNED").text);
  return { qc, user };
}

const rowOf = (text: string) => screen.getByText(text, { exact: false }).closest("li") as HTMLElement;
const categoryOf = (text: string) => rowOf(text).querySelector("[data-category]")?.getAttribute("data-category");
const isRead = (text: string) => rowOf(text).className.includes("opacity-70");
const listTexts = () => within(screen.getByRole("dialog")).getAllByRole("listitem").map((li) => li.textContent ?? "");

describe("one feed, every kind", () => {
  it("1–5. a task, chat, channel and meeting/call notification each appear, drawn as their own category", async () => {
    await openPanel();

    expect(categoryOf(byKind("TASK_ASSIGNED").text)).toBe("task");
    expect(categoryOf(DM_LINE)).toBe("chat");
    expect(categoryOf(CHANNEL_LINE)).toBe("chat");
    expect(categoryOf(byKind("CHANNEL_ADDED").text)).toBe("channel");
    expect(categoryOf(byKind("MEETING_SCHEDULED").text)).toBe("meeting");
    // A call a person is added to is persisted as a meeting invitation with the call's id.
    expect(categoryOf(byKind("MEETING_INVITATION").text)).toBe("meeting");
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
  });

  it("6. every kind is in the one list, newest first — nothing is filtered to tasks", async () => {
    await openPanel();

    const texts = listTexts();
    expect(texts).toHaveLength(rows.length);
    const order = newestFirst(rows).map(shownText);
    texts.forEach((t, i) => expect(t, `row ${i}`).toContain(order[i]));
  });

  it("7. read and unread rows of different kinds coexist: unread first, read kept below", async () => {
    // The server holds the DM and the meeting as already read.
    rows.filter((n) => n.kind === "DM_MESSAGE" || n.kind === "MEETING_SCHEDULED").forEach((n) => (n.read = true));
    await openPanel();

    const texts = listTexts();
    const firstRead = texts.findIndex((t) => t.includes(DM_LINE) || t.includes("Sprint planning"));
    expect(firstRead).toBe(rows.length - 2); // both read rows sit after every unread one
    expect(isRead(DM_LINE)).toBe(true);
    expect(isRead(byKind("MEETING_SCHEDULED").text)).toBe(true);
    expect(isRead(byKind("CHANNEL_ADDED").text)).toBe(false);
    expect(isRead(byKind("TASK_ASSIGNED").text)).toBe(false);
    expect(screen.getByTestId("badge").textContent).toBe(String(rows.length - 2));
  });

  it("10. a kind the client has never heard of shows up with a neutral icon and does not break the panel", async () => {
    const unknown: NotificationDTO = { ...FUTURE, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", kind: "BRAND_NEW_THING", text: "Something brand new", createdAt: "2098-01-01T00:00:00.000Z" };
    rows.push(unknown);
    await openPanel();

    // Both unknown kinds are listed with their data; a sibling of a known family joins it,
    // a stranger gets the neutral icon.
    expect(screen.getByText("Missed call from Priya")).toBeInTheDocument();
    expect(categoryOf("Missed call from Priya")).toBe("meeting"); // CALL_ family → meeting
    expect(screen.getByText("Something brand new")).toBeInTheDocument();
    expect(categoryOf("Something brand new")).toBe("other");
    // Everything else is still there, and neither the error nor the empty state appears.
    expect(listTexts()).toHaveLength(rows.length);
    expect(screen.getByText(byKind("TASK_ASSIGNED").text)).toBeInTheDocument();
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
  });
});

describe("opening a task", () => {
  it("8–9. marks only that task's notifications read; chat, channel, meeting, other tasks and unknown kinds stay unread, and nothing leaves the history", async () => {
    const { qc } = await openPanel();
    const before = rows.length;
    expect(screen.getByTestId("badge").textContent).toBe(String(before));

    await markTaskNotificationsRead(api, qc, [OPEN_TASK]);

    await waitFor(() => expect(isRead(byKind("TASK_ASSIGNED").text)).toBe(true));
    expect(isRead("Task acknowledged by Divya")).toBe(true); // same task, second notification
    // Unrelated notifications of every other category are untouched.
    for (const text of [
      DM_LINE,
      CHANNEL_LINE,
      byKind("CHANNEL_ADDED").text,
      byKind("MEETING_SCHEDULED").text,
      byKind("MEETING_INVITATION").text,
      "Missed call from Priya",
      "Task completed by Piyush", // a DIFFERENT task
    ]) {
      expect(isRead(text), text).toBe(false);
    }
    // The server agrees with what the panel shows, the history is whole, and the bell followed.
    expect(rows.filter((n) => n.read).map((n) => n.id).sort()).toEqual([byKind("TASK_ASSIGNED").id, TASK_ACK.id].sort());
    expect(listTexts()).toHaveLength(before);
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe(String(before - 2)));
  });
});
