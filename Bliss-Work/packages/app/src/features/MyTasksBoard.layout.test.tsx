/**
 * The My tasks workspace is three bands, top to bottom: the filters panel beside
 * the calendar, then one full-width horizontal card per task (four at first), then
 * Load more. jsdom lays nothing out, so this pins the structure — what sits in
 * which zone, what order the bands come in, and that no control moved off its card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SentTaskDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { expandAllDetails } from "../test/expandDetails";

const api = {
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
  taskSchedules: vi.fn(async () => []),
  channels: vi.fn(async () => []),
  addTaskParticipants: vi.fn(),
  withdrawTaskParticipant: vi.fn(),
  reassignTask: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MyTasksBoard } from "./MyTasksBoard";

const AT = "2026-09-19T10:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (id: string, title: string, people: Array<[string, string]>) =>
  ({
    taskId: id,
    title,
    description: "What needs doing, given the whole width of the card to be read in.",
    createdAt: AT,
    participants: people.map(([name, status]) => ({ userId: `u-${name}`, username: name, status })),
    assignees: people.map(([name, status]) => ({ assigneeId: `u-${name}`, assigneeUsername: name, status, assignedAt: AT })),
  }) as unknown as SentTaskDTO;

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ user: { id: "me" } } as never);
  api.tasksSent.mockResolvedValue([task("t1", "Finished task", [["alice", "COMPLETED"]]), task("t2", "Open task", [["alice", "SENT"]])]);
});

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyTasksBoard />
    </QueryClientProvider>,
  );
}

const cardOf = (title: string) => screen.getByText(title).closest('[data-testid="task-card"]') as HTMLElement;
const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("My Tasks workspace", () => {
  it("puts the filters and calendar in one row, with every card after both", async () => {
    renderBoard();
    await screen.findByText("Finished task");
    const filters = screen.getByRole("heading", { name: "Filters" });
    const calendar = screen.getByRole("button", { name: "Today" });
    const firstCard = cardOf("Finished task");

    expect(filters.closest(".grid")).toBe(calendar.closest(".grid"));
    expect(filters.closest(".grid")?.contains(firstCard)).toBe(false);
    expect(before(filters, calendar)).toBe(true);
    expect(before(calendar, firstCard)).toBe(true);
  });

  it("shows four cards at first, one per row, and Load more brings the rest", async () => {
    const user = userEvent.setup();
    api.tasksSent.mockResolvedValue(Array.from({ length: 6 }, (_, i) => task(uuid(i), `Task ${i + 1}`, [["alice", "SENT"]])));
    renderBoard();
    await screen.findByText("Task 1");

    const cards = screen.getAllByTestId("task-card");
    expect(cards).toHaveLength(4);
    expect(new Set(cards.map((c) => c.parentElement)).size).toBe(1);
    const more = screen.getByRole("button", { name: "Load more" });
    expect(before(cards[3]!, more)).toBe(true);

    await user.click(more);
    expect(screen.getAllByTestId("task-card")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("My Tasks card", () => {
  it("holds the task, its people and its standing in one band, with the controls hidden until Details", async () => {
    renderBoard();
    await screen.findByText("Open task");
    const card = cardOf("Open task");

    expect(within(card).getByText(/given the whole width/)).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: "alice" })).toBeInTheDocument(); // the avatar stack
    expect(within(card).getByText("pending")).toBeInTheDocument(); // the status badge
    expect(within(card).getByTestId("task-times")).toBeInTheDocument(); // assigned
    expect(within(card).queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();

    await userEvent.setup().click(within(card).getByRole("button", { name: "Details", expanded: false }));
    expect(within(card).getByRole("button", { name: "Add member" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Withdraw/ })).toBeInTheDocument();
  });

  it("offers Reassign on a finished task without opening Details, and not on an open one", async () => {
    renderBoard();
    await screen.findByText("Finished task");

    expect(within(cardOf("Finished task")).getByRole("button", { name: /^Reassign/ })).toBeInTheDocument();
    expect(within(cardOf("Open task")).queryByRole("button", { name: /^Reassign/ })).not.toBeInTheDocument();
  });

  it("folds avatars past four into +N, and keeps every name for a screen reader", async () => {
    const names = ["ann", "ben", "cy", "di", "ed", "flo"];
    api.tasksSent.mockResolvedValue([task("t1", "Big team", names.map((n) => [n, "SENT"] as [string, string]))]);
    renderBoard();
    await screen.findByText("Big team");
    const card = cardOf("Big team");

    expect(within(card).getByText("+2")).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: names.join(", ") })).toBeInTheDocument();
  });

  it("summarises mixed outcomes as in progress while anyone is still on the task", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "Half done", [["alice", "COMPLETED"], ["bob", "ACKNOWLEDGED"]])]);
    renderBoard();
    await screen.findByText("Half done");
    await expandAllDetails();

    expect(within(cardOf("Half done")).getByText("in progress")).toBeInTheDocument();
    expect(within(cardOf("Half done")).getByText("1/2 done")).toBeInTheDocument();
  });
});
