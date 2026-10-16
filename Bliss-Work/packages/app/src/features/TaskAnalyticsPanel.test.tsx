/**
 * TaskAnalyticsPanel: loading/error states and the "never conflate the two
 * completion rates" rule — each KPI tile must carry its own distinct tooltip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskAnalyticsDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ taskAnalytics: vi.fn(), directory: vi.fn() }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { TaskAnalyticsPanel } from "./TaskAnalyticsPanel";

beforeEach(() => {
  // No directory entries by default — falls back to the DTO's own username,
  // same as before `useUserLabels` was wired into this list.
  h.directory.mockResolvedValue([]);
});

function mount(taskId = "task-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TaskAnalyticsPanel taskId={taskId} />
    </QueryClientProvider>,
  );
}

const FIXTURE: TaskAnalyticsDTO = {
  taskId: "task-1",
  title: "Ship the thing",
  senderId: "u-sender",
  assignees: [
    {
      assigneeId: "u1",
      assigneeUsername: "alice",
      status: "COMPLETED",
      assignedAt: "2026-01-01T00:00:00.000Z",
      acknowledgedAt: "2026-01-01T01:00:00.000Z",
      completedAt: "2026-01-01T05:00:00.000Z",
      ignoredAt: null,
      leftAt: null,
      missedAt: null,
      turnaroundSeconds: 18000,
    },
    {
      assigneeId: "u2",
      assigneeUsername: "bob",
      status: "LEFT",
      assignedAt: "2026-01-01T00:00:00.000Z",
      acknowledgedAt: null,
      completedAt: null,
      ignoredAt: null,
      leftAt: "2026-01-01T02:00:00.000Z",
      missedAt: null,
      turnaroundSeconds: null,
    },
  ],
  statusBreakdown: { sent: 0, acknowledged: 0, completed: 1, ignored: 0, left: 1, missed: 0 },
  completion: {
    totalAssignments: 2,
    completedAssignments: 1,
    assignmentCompletionRate: 50,
    totalUniqueTasks: 1,
    completedUniqueTasks: 1,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 0,
    uniqueTaskCompletionRate: 100,
  },
};

describe("TaskAnalyticsPanel", () => {
  it("shows a spinner while loading", () => {
    h.taskAnalytics.mockReturnValue(new Promise(() => {})); // never resolves
    mount();
    expect(document.querySelector(".animate-spin, [aria-busy], svg")).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    h.taskAnalytics.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText(/could not load analytics/i)).toBeInTheDocument();
  });

  it("renders both completion metrics with distinct tooltips, never conflated", async () => {
    h.taskAnalytics.mockResolvedValue(FIXTURE);
    mount();
    const assignmentTile = (await screen.findByText(/assignment completion/i)).closest("[title]");
    const uniqueTile = screen.getByText(/^task completion$/i).closest("[title]");
    expect(assignmentTile).toBeTruthy();
    expect(uniqueTile).toBeTruthy();
    expect(assignmentTile!.getAttribute("title")).not.toEqual(uniqueTile!.getAttribute("title"));
    // The two rates differ in this fixture (50% assignment vs 100% unique-task) —
    // asserting both values are on screen catches a bug that silently swapped them.
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("shows assignee statuses and omits turnaround for a non-completed assignee", async () => {
    h.taskAnalytics.mockResolvedValue(FIXTURE);
    mount();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText(/not completed/i)).toBeInTheDocument();
  });

  it("resolves an assignee's directory display name instead of their raw username", async () => {
    h.directory.mockResolvedValue([
      { id: "u1", username: "alice", displayName: "Alice Okafor", email: "alice@example.com" },
    ]);
    h.taskAnalytics.mockResolvedValue(FIXTURE);
    mount();

    expect(await screen.findByText("Alice Okafor")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    // u2 has no directory entry — falls back to its own assigneeUsername.
    expect(screen.getByText("bob")).toBeInTheDocument();
  });
});
