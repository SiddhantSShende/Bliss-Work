/**
 * ProjectAnalyticsPanel: loading/error/empty states, the assignment-rate vs
 * unique-task-rate distinction (same correctness risk as ChannelAnalyticsPanel),
 * the overdue KPI, the per-task breakdown list, and pagination (the aggregate
 * metrics must stay stable across pages while `tasks` accumulates).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectAnalyticsDTO, ProjectTaskSummaryDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ projectAnalytics: vi.fn(), directory: vi.fn() }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { ProjectAnalyticsPanel } from "./ProjectAnalyticsPanel";

beforeEach(() => {
  // No directory entries by default — surfaces fall back to the DTO's own
  // username field, same as before `useUserLabels` was wired in.
  h.directory.mockResolvedValue([]);
});

function mount(projectId = "proj-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProjectAnalyticsPanel projectId={projectId} />
    </QueryClientProvider>,
  );
}

function task(over: Partial<ProjectTaskSummaryDTO>): ProjectTaskSummaryDTO {
  return {
    taskId: "t-1",
    title: "Write the report",
    senderId: "sender-1",
    senderUsername: "sender",
    createdAt: "2026-10-01T00:00:00.000Z",
    deadlineAt: null,
    overdue: false,
    taskStatus: "IN_PROGRESS",
    assignees: [],
    ...over,
  };
}

const FIXTURE: ProjectAnalyticsDTO = {
  projectId: "proj-1",
  statusBreakdown: { sent: 10, acknowledged: 10, completed: 60, ignored: 10, left: 10, missed: 0 },
  completion: {
    totalAssignments: 100,
    completedAssignments: 60,
    assignmentCompletionRate: 60,
    totalUniqueTasks: 100,
    completedUniqueTasks: 30,
    abandonedUniqueTasks: 5,
    remainingUniqueTasks: 65,
    uniqueTaskCompletionRate: 30,
  },
  workload: [
    { assigneeId: "u1", assigneeUsername: "alice", assignedCount: 10, completedCount: 8, completionRate: 80 },
    { assigneeId: "u2", assigneeUsername: "bob", assignedCount: 5, completedCount: 1, completionRate: 20 },
  ],
  overdueUniqueTasks: 3,
  tasks: [
    task({
      taskId: "t-1",
      title: "Write the report",
      taskStatus: "COMPLETED",
      assignees: [{ assigneeId: "u1", assigneeUsername: "alice", status: "COMPLETED", assignedAt: "2026-10-01T00:00:00.000Z" }],
    }),
    task({
      taskId: "t-2",
      title: "Ship the deck",
      overdue: true,
      taskStatus: "IN_PROGRESS",
      deadlineAt: "2026-09-01T00:00:00.000Z",
      assignees: [{ assigneeId: "u2", assigneeUsername: "bob", status: "MISSED", assignedAt: "2026-08-01T00:00:00.000Z" }],
    }),
  ],
  tasksOffset: 0,
  tasksLimit: 20,
  tasksTotal: 2,
};

const EMPTY_FIXTURE: ProjectAnalyticsDTO = {
  projectId: "proj-empty",
  statusBreakdown: { sent: 0, acknowledged: 0, completed: 0, ignored: 0, left: 0, missed: 0 },
  completion: {
    totalAssignments: 0,
    completedAssignments: 0,
    assignmentCompletionRate: 0,
    totalUniqueTasks: 0,
    completedUniqueTasks: 0,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 0,
    uniqueTaskCompletionRate: 0,
  },
  workload: [],
  overdueUniqueTasks: 0,
  tasks: [],
  tasksOffset: 0,
  tasksLimit: 20,
  tasksTotal: 0,
};

describe("ProjectAnalyticsPanel", () => {
  it("shows a spinner while loading", () => {
    h.projectAnalytics.mockReturnValue(new Promise(() => {}));
    mount();
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("shows an error state when the fetch fails, with a retry that refetches", async () => {
    h.projectAnalytics.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText(/could not load analytics/i)).toBeInTheDocument();

    h.projectAnalytics.mockResolvedValue(EMPTY_FIXTURE);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("shows a clean empty state for a project with zero tasks, no NaN/divide-by-zero artifacts", async () => {
    h.projectAnalytics.mockResolvedValue(EMPTY_FIXTURE);
    mount();
    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();
  });

  it("renders totals, overdue count, and the distinct assignment-rate vs unique-task-rate numbers", async () => {
    h.projectAnalytics.mockResolvedValue(FIXTURE);
    mount();
    expect(await screen.findByText("100")).toBeInTheDocument(); // totalUniqueTasks KPI
    expect(screen.getByText("30")).toBeInTheDocument(); // completedUniqueTasks KPI
    expect(screen.getByText("3")).toBeInTheDocument(); // overdueUniqueTasks KPI
    expect(screen.getByRole("img", { name: /30%/ })).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("renders per-assignee workload rows", async () => {
    h.projectAnalytics.mockResolvedValue(FIXTURE);
    mount();
    expect(await screen.findByText("8/10 (80%)")).toBeInTheDocument();
    const workload = screen.getByText("8/10 (80%)").closest("ul") as HTMLElement;
    expect(within(workload).getByText("alice")).toBeInTheDocument();
    expect(within(workload).getByText("bob")).toBeInTheDocument();
  });

  it("resolves workload and assignee names from the directory instead of the raw username", async () => {
    h.directory.mockResolvedValue([
      { id: "u1", username: "alice", displayName: "Alice Okafor", email: "alice@example.com" },
    ]);
    h.projectAnalytics.mockResolvedValue(FIXTURE);
    mount();

    // "Alice Okafor" appears twice: once in the workload bars, once in the
    // per-task assignee pill — both resolved through the same directory.
    expect(await screen.findAllByText("Alice Okafor")).toHaveLength(2);
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    // u2 has no directory entry — falls back to its own assigneeUsername,
    // again in both the workload bars and the per-task assignee pill.
    expect(screen.getAllByText("bob")).toHaveLength(2);
  });

  it("renders the per-task breakdown with title, status, and the overdue badge only on the overdue task", async () => {
    h.projectAnalytics.mockResolvedValue(FIXTURE);
    mount();
    const okTask = (await screen.findByText("Write the report")).closest("li") as HTMLElement;
    expect(within(okTask).queryByText(/overdue/i)).not.toBeInTheDocument();

    const lateTask = screen.getByText("Ship the deck").closest("li") as HTMLElement;
    expect(within(lateTask).getByText(/overdue/i)).toBeInTheDocument();
  });

  it("paginates: Load more fetches the next page, appends tasks, and keeps the aggregate metrics stable", async () => {
    const reportTask = task({ taskId: "t-1", title: "Write the report", taskStatus: "COMPLETED" });
    const deckTask = task({ taskId: "t-2", title: "Ship the deck", overdue: true });
    const page1: ProjectAnalyticsDTO = { ...FIXTURE, tasks: [reportTask], tasksOffset: 0, tasksLimit: 1, tasksTotal: 2 };
    const page2: ProjectAnalyticsDTO = { ...FIXTURE, tasks: [deckTask], tasksOffset: 1, tasksLimit: 1, tasksTotal: 2 };
    h.projectAnalytics.mockImplementation((_projectId: string, opts: { offset?: number } = {}) =>
      Promise.resolve(opts.offset ? page2 : page1),
    );
    mount();
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
    expect(screen.queryByText("Ship the deck")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText("Ship the deck")).toBeInTheDocument());
    expect(screen.getByText("Write the report")).toBeInTheDocument();
    // Aggregate metrics (from page 1) are unchanged by loading more tasks.
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });
});
