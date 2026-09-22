import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SentTaskDTO } from "@taskboard/shared";

const api = {
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
// The dialog has its own behaviour; what matters here is what the board hands it.
vi.mock("./CreateReviewDialog", () => ({
  CreateReviewDialog: (p: { assigneeId: string; existingText?: string | null; existingRating?: number | null }) => (
    <div data-testid="review-dialog">
      {p.assigneeId}|{p.existingText}|{p.existingRating}
    </div>
  ),
}));

import { MyTasksBoard } from "./MyTasksBoard";

const NOW = new Date(2026, 8, 15, 12);
const at = (day: number) => new Date(2026, 8, day, 10).toISOString();

const sentTasks = [
  {
    taskId: "t1", title: "Ship the release", description: "", createdAt: at(1),
    assignees: [
      { assigneeId: "u-alice", assigneeUsername: "alice", status: "COMPLETED", assignedAt: at(10), review: null, reviewRating: null },
      { assigneeId: "u-bob", assigneeUsername: "bob", status: "IGNORED", assignedAt: at(10) },
    ],
  },
  {
    taskId: "t2", title: "Write the docs", description: "", createdAt: at(2),
    assignees: [
      { assigneeId: "u-carol", assigneeUsername: "carol", status: "COMPLETED", assignedAt: at(12), review: "Solid work", reviewRating: 4 },
    ],
  },
  {
    taskId: "t3", title: "Fix the flaky test", description: "", createdAt: at(3),
    assignees: [{ assigneeId: "u-alice", assigneeUsername: "alice", status: "SENT", assignedAt: at(12) }],
  },
] as unknown as SentTaskDTO[];

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyTasksBoard />
    </QueryClientProvider>,
  );
}
const titles = () => ["Ship the release", "Write the docs", "Fix the flaky test"].filter((t) => screen.queryByText(t));
const dayButton = (day: number) =>
  screen.getByRole("button", { name: new Date(2026, 8, day).toLocaleDateString(undefined, { dateStyle: "full" }) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  api.tasksSent.mockResolvedValue(sentTasks);
});
afterEach(() => vi.useRealTimers());

describe("MyTasksBoard loading", () => {
  it("shows a loading state, not the empty state, while the first page is on its way", async () => {
    api.tasksSent.mockReturnValue(new Promise(() => {}));
    renderBoard();

    expect(await screen.findByText("Loading your tasks…")).toBeInTheDocument();
    expect(screen.queryByText("You haven't sent any tasks")).not.toBeInTheDocument();
  });

  it("says so, with a Retry, when the first load fails — and recovers on retry", async () => {
    const user = userEvent.setup();
    api.tasksSent.mockRejectedValueOnce(new Error("offline"));
    renderBoard();

    expect(await screen.findByText("Couldn't load your tasks.")).toBeInTheDocument();
    expect(screen.queryByText("You haven't sent any tasks")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ship the release")).toBeInTheDocument();
  });

  it("shows the empty state only once a load has finished with no tasks", async () => {
    api.tasksSent.mockResolvedValue([]);
    renderBoard();

    expect(await screen.findByText("You haven't sent any tasks")).toBeInTheDocument();
    expect(screen.queryByText("Loading your tasks…")).not.toBeInTheDocument();
  });
});

describe("MyTasksBoard data", () => {
  it("asks the server for ignored assignees, which /tasks/sent otherwise hides from the sender", async () => {
    renderBoard();
    await screen.findByText("Ship the release");

    expect(api.tasksSent).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, includeIgnored: true }));
  });
});

describe("MyTasksBoard filters", () => {
  it("shows every task, then narrows by status, person and calendar day together", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");
    expect(titles()).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "completed" }));
    expect(titles()).toEqual(["Ship the release", "Write the docs"]);

    await user.click(screen.getByRole("button", { name: /^.*alice$/ }));
    expect(titles()).toEqual(["Ship the release"]);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toHaveLength(3);
  });

  it("uses the calendar as a date filter, and picking the day again clears it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");

    await user.click(dayButton(12));
    expect(titles()).toEqual(["Write the docs", "Fix the flaky test"]);
    expect(dayButton(12)).toHaveAttribute("aria-pressed", "true");

    await user.click(dayButton(12));
    expect(titles()).toHaveLength(3);
    expect(within(dayButton(10)).getByTestId("task-day-mark")).toBeInTheDocument();
  });

  it("finds an ignored assignee with the Ignored chip", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");
    await user.click(screen.getByRole("button", { name: "ignored" }));
    expect(titles()).toEqual(["Ship the release"]);
    expect(screen.queryByRole("button", { name: /write review/i })).not.toBeInTheDocument();
  });
});

describe("MyTasksBoard reviews", () => {
  it("offers Write review on a completed task without one and Edit review on one with a review", async () => {
    renderBoard();
    await screen.findByText("Ship the release");
    expect(screen.getAllByRole("button", { name: /write review/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /edit review/i })).toHaveLength(1);
  });

  it("hands the review dialog the live assignee's existing review", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write the docs");
    await user.click(screen.getByRole("button", { name: /edit review/i }));
    expect(screen.getByTestId("review-dialog")).toHaveTextContent("u-carol|Solid work|4");
  });
});
