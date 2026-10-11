/**
 * The Missed lifecycle as the user sees it: a task whose deadline passed leaves
 * Allocated to me, appears in the Missed category with its count, keeps its
 * original assigned time and deadline, and gets there LIVE when task-svc's
 * `task.missed` arrives — without a manual refresh.
 *
 * Mounts the real sidebar (TasksList), the real page (Tasks) and the real realtime
 * bridge (WsEventBridge) on one query client, against a tiny in-memory task-svc.
 * The socket is the only fake: tests push the events task-svc would.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, EventType, type AssigneeStatus, type StickyTaskDTO, type WsEventMeta } from "@taskboard/shared";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";
const SENDER = "00000000-0000-4000-8000-000000000001";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";

const h = vi.hoisted(() => ({
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
  toasts: [] as string[],
  api: {
    taskAssigned: vi.fn(),
    tasksSent: vi.fn(),
    taskAvailability: vi.fn(),
    directory: vi.fn(),
    stickyPinStates: vi.fn(),
    taskAction: vi.fn(),
  },
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: h.api,
    config: {},
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      onStatus: () => () => {},
      on: (cb: (e: unknown, meta?: WsEventMeta) => void) => {
        h.emit = cb;
        return () => {};
      },
    },
  }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign((m: string) => h.toasts.push(m), {
    error: (m: string) => h.toasts.push(m),
    success: (m: string) => h.toasts.push(m),
  }),
}));
// useOpenTaskDiscussion (the task card's Chat button) reads useSelectedChat;
// this suite exercises neither Chat nor DM navigation, so a plain stub is enough.
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

import { WsEventBridge } from "../lib/queryBridge";
import { Tasks } from "./Tasks";
import { TasksList } from "./TasksList";

function task(id: string, title: string, status: AssigneeStatus, over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
    description: "",
    senderId: SENDER,
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [],
    assignedAt: "2026-09-19T10:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  } as StickyTaskDTO;
}

let server: StickyTaskDTO[] = [];

function mount(view = "allocated") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/app/tasks/${view}`]}>
        <WsEventBridge />
        <nav aria-label="categories">
          <TasksList />
        </nav>
        <Routes>
          <Route path="/app/tasks/:view" element={<Tasks />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** The sidebar row for a category: its link, whose text is "<label><count>". */
const category = (name: string) => within(screen.getByRole("navigation", { name: "categories" })).getByRole("link", { name: new RegExp(`^${name}`) });
const card = (title: string) => screen.getByText(title).closest("[data-task-card]") as HTMLElement;

function missedEvent(taskId: string, over: Record<string, unknown> = {}) {
  return {
    type: EventType.TaskMissed,
    eventId: "55555555-5555-4555-8555-555555555555",
    orgId: "00000000-0000-4000-8000-000000000002",
    occurredAt: "2026-09-19T16:00:03.000Z",
    taskId,
    assigneeId: ME,
    senderId: SENDER,
    statusVersion: 2,
    assigneeUsername: "me",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.toasts.length = 0;
  h.emit = undefined;
  useSession.setState({ status: "authed", user: { id: ME, orgId: "org" } } as never);
  server = [
    task(A, "Write the report", "SENT", { deadlineAt: "2026-09-19T16:00:00.000Z" }),
    task(B, "Review the deck", "ACKNOWLEDGED"),
    task(C, "File the expenses", "MISSED", {
      statusVersion: 2,
      deadlineAt: "2026-09-18T16:00:00.000Z",
      missedAt: "2026-09-18T16:00:02.000Z",
    }),
  ];
  h.api.taskAssigned.mockImplementation(async () => structuredClone(server));
  h.api.tasksSent.mockResolvedValue([]);
  h.api.taskAvailability.mockResolvedValue({ counts: [], hiddenUserIds: [], canManage: false });
  h.api.directory.mockResolvedValue([]);
  h.api.stickyPinStates.mockResolvedValue({ unpinned: [] });
});

describe("the Missed category", () => {
  it("is in the Tasks navigation with the number of missed tasks", async () => {
    mount();
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
    await waitFor(() => expect(category("Missed")).toHaveTextContent("1"));
    // The other counts are unchanged by it: only the two live tasks are Allocated.
    expect(category("Allocated to me")).toHaveTextContent("2");
  });

  it("holds no zero badge when nothing is missed", async () => {
    server = server.filter((t) => t.myStatus !== "MISSED");
    mount();
    await screen.findByText("Write the report");
    expect(category("Missed")).not.toHaveTextContent(/\d/);
  });

  it("keeps a missed task out of Allocated to me", async () => {
    mount();
    await screen.findByText("Write the report");
    expect(screen.getByText("Review the deck")).toBeInTheDocument();
    expect(screen.queryByText("File the expenses")).not.toBeInTheDocument();
  });

  it("lists it under Missed, marked as missed, with its assigned time and deadline and no actions", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Write the report");
    await user.click(category("Missed"));

    const missed = await screen.findByText("File the expenses");
    const el = missed.closest("[data-task-card]") as HTMLElement;
    // (the Allocated cards play an exit animation, so they leave a beat later)
    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());
    expect(within(el).getByText("missed")).toBeInTheDocument(); // the status badge
    const times = within(el).getByTestId("task-times");
    expect(times).toHaveTextContent("Assigned");
    expect(times).toHaveTextContent("Deadline");
    expect(times).toHaveTextContent("Missed");
    // The ORIGINAL assigned instant and deadline are what is printed.
    const stamps = [...times.querySelectorAll("time")].map((t) => t.getAttribute("datetime"));
    expect(stamps).toEqual(["2026-09-19T10:00:00.000Z", "2026-09-18T16:00:00.000Z", "2026-09-18T16:00:02.000Z"]);
    // Nothing left to act on.
    expect(within(el).queryByRole("button", { name: /Acknowledge|Ignore|Complete|Leave/ })).not.toBeInTheDocument();
  });

  it("explains an empty Missed bucket", async () => {
    server = server.filter((t) => t.myStatus !== "MISSED");
    const user = userEvent.setup();
    mount();
    await screen.findByText("Write the report");
    await user.click(category("Missed"));
    expect(await screen.findByText(/deadline passes before you finish it/)).toBeInTheDocument();
  });
});

describe("a deadline passing while the app is open", () => {
  it("moves the card from Allocated to Missed, live, and updates both counts", async () => {
    mount();
    await screen.findByText("Write the report");
    await waitFor(() => expect(h.emit).toBeDefined());
    expect(category("Allocated to me")).toHaveTextContent("2");

    // task-svc's sweeper marks it, then tells us.
    server = server.map((t) => (t.taskId === A ? { ...t, myStatus: "MISSED", actions: [], statusVersion: 2, missedAt: "2026-09-19T16:00:03.000Z" } : t));
    act(() => h.emit!(missedEvent(A), { replayed: false }));

    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());
    expect(screen.getByText("Review the deck")).toBeInTheDocument(); // untouched
    await waitFor(() => expect(category("Missed")).toHaveTextContent("2"));
    expect(category("Allocated to me")).toHaveTextContent("1");
    expect(h.toasts.some((m) => /deadline passed/i.test(m))).toBe(true);
  });

  it("moves it the moment the event lands, before any refetch answers", async () => {
    mount();
    await screen.findByText("Write the report");
    await waitFor(() => expect(h.emit).toBeDefined());
    // The server still says SENT (a lagging read): the patched cache is what the user sees.
    h.api.taskAssigned.mockImplementation(() => new Promise(() => {}));
    act(() => h.emit!(missedEvent(A), { replayed: false }));
    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());
    expect(category("Missed")).toHaveTextContent("2");
  });

  it("does not announce a replayed event (a reconnect), but still applies it", async () => {
    mount();
    await screen.findByText("Write the report");
    await waitFor(() => expect(h.emit).toBeDefined());
    server = server.map((t) => (t.taskId === A ? { ...t, myStatus: "MISSED", actions: [], statusVersion: 2 } : t));
    act(() => h.emit!(missedEvent(A), { replayed: true }));
    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());
    expect(h.toasts).toEqual([]);
  });

  it("leaves other people's tasks alone: an event for another assignee does not move my card", async () => {
    mount();
    await screen.findByText("Write the report");
    await waitFor(() => expect(h.emit).toBeDefined());
    act(() => h.emit!(missedEvent(A, { assigneeId: "99999999-9999-4999-8999-999999999999", senderId: ME }), { replayed: false }));
    await waitFor(() => expect(h.toasts.some((m) => /missed by/i.test(m))).toBe(true));
    expect(screen.getByText("Write the report")).toBeInTheDocument();
    expect(card("Write the report")).toBeInTheDocument();
  });
});
