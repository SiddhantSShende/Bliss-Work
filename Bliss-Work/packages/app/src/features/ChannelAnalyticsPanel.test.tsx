/**
 * ChannelAnalyticsPanel: loading/error/empty(zero-task) states, and — the
 * core correctness risk of this feature — the assignment-level rate and the
 * unique-task rate must render as two distinct, separately-tooltipped
 * numbers, never merged into one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelAnalyticsDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ channelAnalytics: vi.fn(), directory: vi.fn() }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { ChannelAnalyticsPanel } from "./ChannelAnalyticsPanel";

beforeEach(() => {
  // No directory entries by default — falls back to the DTO's own username,
  // same as before `useUserLabels` was wired into the workload bars.
  h.directory.mockResolvedValue([]);
});

function mount(channelId = "chan-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChannelAnalyticsPanel channelId={channelId} />
    </QueryClientProvider>,
  );
}

// Mirrors the request's own worked example: 100 unique tasks, 30 completed.
const FIXTURE: ChannelAnalyticsDTO = {
  channelId: "chan-1",
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
};

const EMPTY_FIXTURE: ChannelAnalyticsDTO = {
  channelId: "chan-empty",
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
};

describe("ChannelAnalyticsPanel", () => {
  it("shows a spinner while loading", () => {
    h.channelAnalytics.mockReturnValue(new Promise(() => {}));
    mount();
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    h.channelAnalytics.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText(/could not load analytics/i)).toBeInTheDocument();
  });

  it("shows a clean empty state for a channel with zero tasks, no NaN/divide-by-zero artifacts", async () => {
    h.channelAnalytics.mockResolvedValue(EMPTY_FIXTURE);
    mount();
    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();
  });

  it("renders the 100-task/30-completed example as 30% unique-task completion, distinct from the 60% assignment rate", async () => {
    h.channelAnalytics.mockResolvedValue(FIXTURE);
    mount();
    expect(await screen.findByText("30")).toBeInTheDocument(); // completedUniqueTasks KPI
    expect(screen.getByText("100")).toBeInTheDocument(); // totalUniqueTasks KPI
    // The ring draws the unique-task rate (30%); the assignment-rate tile is a
    // separate 60% — if these ever got swapped or merged this assertion fails.
    expect(screen.getByRole("img", { name: /30%/ })).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    const assignmentTile = screen.getByText(/assignment completion/i).closest("[title]");
    expect(assignmentTile!.getAttribute("title")).toMatch(/every assignment in scope/i);
  });

  it("renders per-assignee workload rows", async () => {
    h.channelAnalytics.mockResolvedValue(FIXTURE);
    mount();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("8/10 (80%)")).toBeInTheDocument();
  });

  it("resolves a workload row's directory display name instead of its raw username", async () => {
    h.directory.mockResolvedValue([
      { id: "u1", username: "alice", displayName: "Alice Okafor", email: "alice@example.com" },
    ]);
    h.channelAnalytics.mockResolvedValue(FIXTURE);
    mount();

    expect(await screen.findByText("Alice Okafor")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    // u2 has no directory entry — falls back to its own assigneeUsername.
    expect(screen.getByText("bob")).toBeInTheDocument();
  });
});
