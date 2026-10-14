/**
 * WorkspaceOverview: open to every authenticated member now (authorization
 * lives server-side — see tasks_analytics.workspace_overview — scoping a
 * non-admin's rows to their own tasks rather than hiding the panel), loading/
 * error/empty states, and that the range tabs / channel filter actually
 * refetch with new query params rather than being decorative.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChannelDTO, type WorkspaceOverviewDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ channels: vi.fn(), workspaceAnalyticsOverview: vi.fn() }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { WorkspaceOverview } from "./WorkspaceOverview";

const CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = ChannelDTO.parse({
  id: CHANNEL_ID,
  name: "Design",
  memberCount: 1,
  lastMessage: null,
  lastMessageAt: null,
});

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
  channels: [{ channelId: CHANNEL_ID, totalUniqueTasks: 4, completedUniqueTasks: 2, completionRate: 50 }],
  dailyActivity: [
    { day: "2026-10-01", tasksCreated: 2, tasksCompleted: 1 },
    { day: "2026-10-02", tasksCreated: 2, tasksCompleted: 1 },
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
  channels: [],
  dailyActivity: [],
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
    h.channels.mockResolvedValue([CHANNEL]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();

    const totalLabel = await screen.findByText("Total Tasks");
    const kpiGrid = totalLabel.closest(".grid");
    expect(kpiGrid).not.toBeNull();
    const kpi = within(kpiGrid as HTMLElement);
    expect(kpi.getByText("Total Tasks").parentElement).toHaveTextContent("4");
    expect(kpi.getByText("Completed").parentElement).toHaveTextContent("2");
    expect(kpi.getByText("In Progress").parentElement).toHaveTextContent("1");
    expect(kpi.getByText("Overdue").parentElement).toHaveTextContent("1");
  });

  it("resolves channel names from the channels list, not raw ids", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();

    const channelSection = (await screen.findByText("Channel Performance")).closest("section");
    expect(within(channelSection as HTMLElement).getByText("Design")).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks in range", async () => {
    h.channels.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount();

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });

  it("shows a retry control on error", async () => {
    h.channels.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockRejectedValue(new Error("boom"));
    mount();

    expect(await screen.findByText("Couldn't load the overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("refetches with a new date range when a range tab is clicked", async () => {
    h.channels.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(1));
    const firstCall = h.workspaceAnalyticsOverview.mock.calls[0][0];

    await userEvent.click(screen.getByRole("tab", { name: /last 7 days/i }));

    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(2));
    const secondCall = h.workspaceAnalyticsOverview.mock.calls[1][0];
    expect(secondCall.from).not.toBe(firstCall.from);
  });

  it("refetches scoped to one channel when the channel filter changes", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.workspaceAnalyticsOverview.mockResolvedValue(OVERVIEW);
    mount();
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(await screen.findByRole("combobox"), CHANNEL_ID);

    await waitFor(() =>
      expect(h.workspaceAnalyticsOverview).toHaveBeenLastCalledWith(
        expect.objectContaining({ channelId: CHANNEL_ID }),
      ),
    );
  });
});
