/**
 * WorkspaceOverview: open to every authenticated member now (authorization
 * lives server-side — see tasks_analytics.workspace_overview — scoping a
 * non-admin's rows to their own tasks rather than hiding the panel), loading/
 * error/empty states, and that the range tabs / project filter actually
 * refetch with new query params rather than being decorative. The dashboard
 * is project-wise — see ProjectPerformanceList — not channel-wise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectDTO, type WorkspaceOverviewDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ projects: vi.fn(), workspaceAnalyticsOverview: vi.fn() }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { WorkspaceOverview } from "./WorkspaceOverview";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = ProjectDTO.parse({
  id: PROJECT_ID,
  name: "Design",
  channelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "ACTIVE",
  canComplete: false,
});

function kpi(value: number, previousValue: number, sparkline: number[]) {
  return {
    value,
    previousValue,
    deltaPct: previousValue ? ((value - previousValue) / previousValue) * 100 : null,
    sparkline,
  };
}

const OVERVIEW: WorkspaceOverviewDTO = {
  statusBreakdown: { sent: 1, acknowledged: 0, completed: 2, ignored: 0, left: 0, missed: 1 },
  completion: {
    totalAssignments: 4,
    completedAssignments: 2,
    assignmentCompletionRate: 50,
    totalUniqueTasks: 4,
    completedUniqueTasks: 2,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 2,
    uniqueTaskCompletionRate: 50,
  },
  overdueUniqueTasks: 1,
  inProgressUniqueTasks: 1,
  workload: [
    { assigneeId: "u1", assigneeUsername: "alice", assignedCount: 3, completedCount: 2, inProgressCount: 1, completionRate: 66.7 },
  ],
  projectPerformance: [
    { projectId: PROJECT_ID, name: "Design", totalUniqueTasks: 4, completedUniqueTasks: 2, completionRate: 50, trendPct: 10 },
  ],
  dailyActivity: [
    { day: "2026-10-01", tasksCreated: 2, tasksCompleted: 1 },
    { day: "2026-10-02", tasksCreated: 2, tasksCompleted: 1 },
  ],
  kpis: {
    totalTasks: kpi(4, 3, [2, 2]),
    completed: kpi(2, 2, [1, 1]),
    inProgress: kpi(1, 0, [1, 0]),
    overdue: kpi(1, 2, [0, 1]),
  },
  statusFlow: [
    { day: "2026-10-01", sent: 1, acknowledged: 0, completed: 1, missed: 0, ignored: 0, left: 0 },
    { day: "2026-10-02", sent: 0, acknowledged: 0, completed: 1, missed: 1, ignored: 0, left: 0 },
  ],
  rangeFrom: "2026-10-01",
  rangeTo: "2026-10-02",
};

const EMPTY_OVERVIEW: WorkspaceOverviewDTO = {
  ...OVERVIEW,
  completion: { ...OVERVIEW.completion, totalUniqueTasks: 0, completedUniqueTasks: 0, remainingUniqueTasks: 0 },
  overdueUniqueTasks: 0,
  inProgressUniqueTasks: 0,
  workload: [],
  projectPerformance: [],
  dailyActivity: [],
  kpis: {
    totalTasks: kpi(0, 0, []),
    completed: kpi(0, 0, []),
    inProgress: kpi(0, 0, []),
    overdue: kpi(0, 0, []),
  },
  statusFlow: [],
};

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceOverview />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceOverview", () => {
  it("fetches and shows KPI totals — no client-side role gate", async () => {
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();

    const totalLabel = await screen.findByText("Total Tasks");
    const kpiGrid = totalLabel.closest(".grid");
    expect(kpiGrid).not.toBeNull();
    const kpiScope = within(kpiGrid as HTMLElement);
    expect(kpiScope.getByText("Total Tasks").parentElement).toHaveTextContent("4");
    expect(kpiScope.getByText("Completed").parentElement).toHaveTextContent("2");
    expect(kpiScope.getByText("In Progress").parentElement).toHaveTextContent("1");
    expect(kpiScope.getByText("Overdue").parentElement).toHaveTextContent("1");
  });

  it("shows project names from the project performance ranking", async () => {
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();

    const projectSection = (await screen.findByText("Project Performance")).closest("div");
    expect(within(projectSection as HTMLElement).getByText("Design")).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks in range", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount();

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });

  it("shows a retry control on error", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockRejectedValue(new Error("boom"));
    mount();

    expect(await screen.findByText("Couldn't load the overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("refetches with a new date range when a range tab is clicked", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(1));
    const firstCall = h.workspaceAnalyticsOverview.mock.calls[0]?.[0];

    await userEvent.click(screen.getByRole("tab", { name: /last 7 days/i }));

    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(2));
    const secondCall = h.workspaceAnalyticsOverview.mock.calls[1]?.[0];
    expect(secondCall.from).not.toBe(firstCall.from);
  });

  it("refetches scoped to one project when the project filter changes", async () => {
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(await screen.findByRole("combobox"), PROJECT_ID);

    await waitFor(() =>
      expect(h.workspaceAnalyticsOverview).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID }),
      ),
    );
  });
});
