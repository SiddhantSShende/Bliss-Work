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

const h = vi.hoisted(() => ({ projects: vi.fn(), workspaceAnalyticsOverview: vi.fn(), directory: vi.fn() }));
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
    h.directory.mockResolvedValue([]);
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

  it("places each KPI sparkline beside its text on wide layouts", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([]);
    mount();

    const label = await screen.findByText("Total Tasks");
    const content = label.parentElement?.parentElement;
    expect(content).toHaveClass("flex", "flex-col", "lg:flex-row");
    expect(content?.querySelector("svg")).toHaveClass("m-0", "shrink-0");
  });

  it("keeps the status donut beside a vertically aligned legend and reuses its colors in status flow", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([]);
    mount();

    const statusTitle = await screen.findByText("Status Distribution");
    const statusCard = statusTitle.parentElement;
    const layout = statusCard?.querySelector("h3 + div");
    const donut = layout?.querySelector("svg");
    const legend = layout?.querySelector("dl");
    expect(layout).toHaveClass("flex", "items-center");
    expect(donut).toHaveClass("aspect-square", "shrink-0");
    expect(legend).toHaveClass("flex-col");

    const legendColors = new Set(
      Array.from(legend?.querySelectorAll("dt > span:first-child") ?? []).map(
        (marker) => (marker as HTMLElement).style.background,
      ),
    );
    const donutColors = Array.from(donut?.querySelectorAll("circle[stroke-dasharray]") ?? []).map(
      (segment) => segment.getAttribute("stroke"),
    );
    for (const color of donutColors) expect(legendColors).toContain(color);

    const flowCard = screen.getByText("Status Flow").parentElement;
    const flowColors = Array.from(flowCard?.querySelectorAll("rect") ?? []).map((segment) =>
      segment.getAttribute("fill"),
    );
    for (const color of flowColors) expect(legendColors).toContain(color);
  });

  it("colors workload points by quadrant and shows the horizontal and vertical divisions", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue({
      ...OVERVIEW,
      workload: [
        { assigneeId: "low-high", assigneeUsername: "one", assignedCount: 1, completedCount: 1, inProgressCount: 0, completionRate: 80 },
        { assigneeId: "low-low", assigneeUsername: "two", assignedCount: 2, completedCount: 0, inProgressCount: 2, completionRate: 20 },
        { assigneeId: "high-high", assigneeUsername: "three", assignedCount: 4, completedCount: 3, inProgressCount: 1, completionRate: 80 },
        { assigneeId: "high-low", assigneeUsername: "four", assignedCount: 5, completedCount: 1, inProgressCount: 4, completionRate: 20 },
      ],
    });
    h.directory.mockResolvedValue([]);
    mount();

    const chart = await screen.findByRole("img", {
      name: "Each point is one person: assigned workload against their completion rate.",
    });
    const pointColors = Array.from(chart.querySelectorAll("circle")).map((point) => point.getAttribute("fill"));
    expect(new Set(pointColors)).toEqual(
      new Set([
        "var(--color-scatter-low-high)",
        "var(--color-scatter-low-low)",
        "var(--color-scatter-high-high)",
        "var(--color-scatter-high-low)",
      ]),
    );
    expect(chart.querySelectorAll("rect")).toHaveLength(4);
    expect(chart.querySelectorAll("line[stroke-dasharray]")).toHaveLength(2);
    expect(screen.getByText("High efficiency / Low load")).toBeInTheDocument();
    expect(screen.getByText("High efficiency / High load")).toBeInTheDocument();
    expect(screen.getByText("Low efficiency / Low load")).toBeInTheDocument();
    expect(screen.getByText("Low efficiency / High load")).toBeInTheDocument();
  });

  it("shows project names from the project performance ranking", async () => {
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([]);
    mount();

    const projectSection = (await screen.findByText("Project Performance")).closest("div");
    expect(within(projectSection as HTMLElement).getByText("Design")).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks in range", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    h.directory.mockResolvedValue([]);
    mount();

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });

  it("shows a retry control on error", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockRejectedValue(new Error("boom"));
    h.directory.mockResolvedValue([]);
    mount();

    expect(await screen.findByText("Couldn't load the overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("refetches with a new date range when a range tab is clicked", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([]);
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
    h.directory.mockResolvedValue([]);
    mount();
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(await screen.findByRole("combobox"), PROJECT_ID);

    await waitFor(() =>
      expect(h.workspaceAnalyticsOverview).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID }),
      ),
    );
  });

  it("shows the person's directory display name, not their raw username", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([
      { id: "u1", username: "alice", displayName: "Alice Okafor", email: "alice@example.com" },
    ]);
    mount();

    const workloadSection = (await screen.findByText("Person Workload")).closest("div");
    expect(within(workloadSection as HTMLElement).getByText("Alice Okafor")).toBeInTheDocument();
    expect(within(workloadSection as HTMLElement).queryByText("alice")).not.toBeInTheDocument();
  });

  it("falls back to the DTO's username when the directory has no entry for that person", async () => {
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    h.directory.mockResolvedValue([]);
    mount();

    const workloadSection = (await screen.findByText("Person Workload")).closest("div");
    expect(within(workloadSection as HTMLElement).getByText("alice")).toBeInTheDocument();
  });
});
