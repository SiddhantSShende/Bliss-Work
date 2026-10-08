/**
 * Closing the notification panel reads what it was showing — on the SERVER.
 *
 * Real here: the ApiClient (strict zod schemas), the cache plumbing, the panel and the
 * close hook. Replaced: only the network, by a small in-memory notification-svc that pages
 * by cursor, honours the read filter, keeps the unread count and records every read request.
 * 25 unread notifications are on the server but the panel loads one page of 10, so "only
 * what was loaded" is a real distinction rather than a coincidence.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, type NotificationDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { useNotificationPages } from "../lib/useCursorPagination";
import { mergeNotificationFeeds } from "../lib/notificationPages";
import { NotificationsPanel } from "./NotificationsPanel";

const api = new ApiClient({ notificationBase: "http://notif.test", getToken: async () => "tok" } as never);
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const row = (i: number, read = false): NotificationDTO => ({
  id: id(i),
  kind: "TASK_ASSIGNED",
  text: `Task ${i}`,
  taskId: id(1000 + i),
  read,
  createdAt: new Date(Date.UTC(2026, 9, 6, 9, 0, i)).toISOString(),
});

// ── the fake server ──────────────────────────────────────────────────────────────
let rows: NotificationDTO[] = [];
let readRequests: string[] = [];
let readAllRequests = 0;
let failReads = false;
/** While set, a read request waits for it before the server applies it. */
let gate: Promise<void> | null = null;

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  rows = [...Array.from({ length: 25 }, (_, i) => row(100 + i)), row(1, true), row(2, true)];
  readRequests = [];
  readAllRequests = 0;
  failReads = false;
  gate = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/unread-count")) return json({ unreadCount: rows.filter((n) => !n.read).length });
      if (path.endsWith("/read-all")) {
        readAllRequests++;
        return json({});
      }
      const one = path.match(/\/notifications\/([^/]+)\/read$/);
      if (one && init?.method === "POST") {
        readRequests.push(one[1]!);
        await gate;
        if (failReads) return json({ error: "boom" }, 500);
        rows.filter((n) => n.id === one[1]).forEach((n) => (n.read = true));
        return json({});
      }
      const wantRead = url.searchParams.get("read");
      const matching = [...rows]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter((n) => wantRead === null || n.read === (wantRead === "true"));
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + limit;
      return json({ items: matching.slice(start, end), nextCursor: end < matching.length ? String(end) : null });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// ── the app side, wired like AppShell wires it ───────────────────────────────────
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

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app"]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  // The badge is loaded before anything else: it is what the user sees before opening.
  await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("25"));
  return user;
}

const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /Open notifications/i }));
  await screen.findByRole("dialog");
};
const closePanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
};
const badge = () => screen.getByTestId("badge").textContent;
const markReadButtons = () => screen.queryAllByRole("button", { name: "Mark read" });
const rowOf = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
const isRead = (text: string) => rowOf(text).className.includes("opacity-70");
/** The 10 newest unread notifications: the first page the panel loads. */
const LOADED = Array.from({ length: 10 }, (_, i) => id(124 - i));

describe("closing the panel reads what it loaded", () => {
  it("reads every loaded unread notification on the server, by id — and only those", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    expect(markReadButtons()).toHaveLength(10);

    await closePanel(user);

    const readNow = () => rows.filter((n) => n.read && Number(n.id.slice(-12)) >= 100).map((n) => n.id).sort();
    await waitFor(() => expect(readNow()).toEqual([...LOADED].sort()));
    expect([...readRequests].sort()).toEqual([...LOADED].sort());
    // The 15 unread ones beyond the loaded page were never shown, so were never read.
    expect(rows.filter((n) => !n.read)).toHaveLength(15);
    expect(readAllRequests).toBe(0);
  });

  it("lowers the badge at once, by the loaded rows only, and the server's count agrees", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve)); // the server has not answered yet

    await closePanel(user);

    expect(badge()).toBe("15"); // 25 − the 10 that were on screen, before any response
    release();
    await waitFor(() => expect(readRequests).toHaveLength(10));
    await waitFor(() => expect(badge()).toBe("15"));
  });

  it("does not show them as unread again when the panel is reopened", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    await closePanel(user);
    await waitFor(() => expect(rows.filter((n) => !n.read)).toHaveLength(15));

    await openPanel(user);

    await screen.findByText("Task 124");
    await waitFor(() => expect(isRead("Task 124")).toBe(true));
    for (const i of [115, 120, 124]) expect(isRead(`Task ${i}`)).toBe(true);
    // What is still unread is the next page — never the rows that were just closed over.
    await screen.findByText("Task 114");
    expect(isRead("Task 114")).toBe(false);
    expect(markReadButtons()).toHaveLength(10);
  });
});

describe("an already-read panel", () => {
  it("closes without a request and without an error", async () => {
    rows = rows.map((n) => ({ ...n, read: true }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/app"]}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await openPanel(user);
    await screen.findByText("Task 124");
    expect(markReadButtons()).toHaveLength(0);

    await closePanel(user);
    await openPanel(user);
    await closePanel(user);

    expect(readRequests).toEqual([]);
    expect(readAllRequests).toBe(0);
    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
  });

  it("a panel opened and closed before anything loaded sends nothing", async () => {
    const user = await mount();
    let unblock!: () => void;
    const slow = new Promise<void>((resolve) => (unblock = resolve));
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("read=")) await slow;
      return real(...args);
    }));

    await openPanel(user);
    await closePanel(user);
    unblock();

    expect(readRequests).toEqual([]);
    expect(badge()).toBe("25");
  });
});

describe("rapid open and close", () => {
  it("sends one request per notification however often the panel is closed and reopened", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve)); // every read stays on the wire

    await closePanel(user);
    await openPanel(user);
    await closePanel(user);
    await openPanel(user);
    await closePanel(user);
    release();

    await waitFor(() => expect(rows.filter((n) => !n.read)).toHaveLength(15));
    expect(readRequests).toHaveLength(10);
    expect(new Set(readRequests).size).toBe(10);
    expect(readAllRequests).toBe(0);
  });

  it("a panel reopened while the requests are still in flight does not light those rows up again", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    await closePanel(user);

    await openPanel(user); // the server still holds all 25 unread: its unread feed says so
    await screen.findByText("Task 124");

    expect(isRead("Task 124")).toBe(true);
    expect(isRead("Task 115")).toBe(true);
    release();
    await waitFor(() => expect(rows.filter((n) => !n.read)).toHaveLength(15));
    await waitFor(() => expect(isRead("Task 124")).toBe(true));
    expect(markReadButtons().every((b) => !rowOf("Task 124").contains(b))).toBe(true);
  });
});

describe("a failed read request", () => {
  it("never leaves the rows looking permanently read: the server's answer brings them back", async () => {
    failReads = true;
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    await closePanel(user);
    await waitFor(() => expect(readRequests).toHaveLength(10));

    // The server read none of them, so the count and the list say so again.
    await waitFor(() => expect(badge()).toBe("25"));
    expect(rows.filter((n) => !n.read)).toHaveLength(25);
    await openPanel(user);
    await screen.findByText("Task 124");
    await waitFor(() => expect(isRead("Task 124")).toBe(false));
    expect(markReadButtons()).toHaveLength(10);
  });

  it("a request that fails for some rows puts back exactly those", async () => {
    const user = await mount();
    await openPanel(user);
    await screen.findByText("Task 124");
    const flaky = id(120);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith(`/notifications/${flaky}/read`)) {
        readRequests.push(flaky);
        return json({ error: "boom" }, 500);
      }
      return real(...args);
    }));

    await closePanel(user);

    await waitFor(() => expect(badge()).toBe("16")); // 25 − 9 that did land
    await openPanel(user);
    await screen.findByText("Task 120");
    await waitFor(() => expect(isRead("Task 120")).toBe(false));
    expect(isRead("Task 124")).toBe(true);
  });
});
