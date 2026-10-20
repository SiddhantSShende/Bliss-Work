import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  ChannelDTO,
  type ChannelAnalyticsDTO,
  type ProjectAnalyticsDTO,
  type ProjectDTO,
  type WorkspaceOverviewDTO,
} from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channels: vi.fn(),
  channelAnalytics: vi.fn(),
  projects: vi.fn(),
  projectDetail: vi.fn(),
  projectAnalytics: vi.fn(),
  workspaceAnalyticsOverview: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { Analytics } from "./Analytics";

const CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = ChannelDTO.parse({
  id: CHANNEL_ID,
  name: "Design",
  memberCount: 1,
  lastMessage: null,
  lastMessageAt: null,
});
const ANALYTICS: ChannelAnalyticsDTO = {
  channelId: CHANNEL_ID,
  statusBreakdown: { sent: 1, acknowledged: 0, completed: 2, ignored: 0, left: 0, missed: 0 },
  completion: {
    totalAssignments: 3,
    completedAssignments: 2,
    assignmentCompletionRate: 66.7,
    totalUniqueTasks: 3,
    completedUniqueTasks: 2,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 1,
    uniqueTaskCompletionRate: 66.7,
  },
  workload: [],
};

const PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_OWN_CHANNEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT: ProjectDTO = {
  id: PROJECT_ID,
  name: "Launch Plan",
  channelId: PROJECT_OWN_CHANNEL_ID,
  channelIds: [PROJECT_OWN_CHANNEL_ID],
  status: "ACTIVE",
  canComplete: false,
};
const PROJECT_ANALYTICS: ProjectAnalyticsDTO = {
  projectId: PROJECT_ID,
  statusBreakdown: { sent: 1, acknowledged: 0, completed: 4, ignored: 0, left: 0, missed: 0 },
  completion: {
    totalAssignments: 5,
    completedAssignments: 4,
    assignmentCompletionRate: 80,
    totalUniqueTasks: 5,
    completedUniqueTasks: 4,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 1,
    uniqueTaskCompletionRate: 80,
  },
  workload: [],
  overdueUniqueTasks: 0,
  tasks: [],
  tasksOffset: 0,
  tasksLimit: 20,
  tasksTotal: 5,
};

const EMPTY_OVERVIEW: WorkspaceOverviewDTO = {
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
  overdueUniqueTasks: 0,
  inProgressUniqueTasks: 0,
  workload: [],
  projectPerformance: [],
  dailyActivity: [],
  kpis: {
    totalTasks: { value: 0, previousValue: 0, deltaPct: null, sparkline: [] },
    completed: { value: 0, previousValue: 0, deltaPct: null, sparkline: [] },
    inProgress: { value: 0, previousValue: 0, deltaPct: null, sparkline: [] },
    overdue: { value: 0, previousValue: 0, deltaPct: null, sparkline: [] },
  },
  statusFlow: [],
  rangeFrom: "2026-10-01",
  rangeTo: "2026-10-02",
};

function mount(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/analytics" element={<Analytics />} />
          <Route path="/app/analytics/projects/:projectId" element={<Analytics />} />
          <Route path="/app/analytics/:channelId" element={<Analytics />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Analytics route", () => {
  it("does not expose channel selection in the header dropdown (channel-wise dashboard removed)", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount("/app/analytics");
    const selector = await screen.findByRole("combobox", { name: "Projects" });
    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalled());
    expect(within(selector).queryByRole("option", { name: "Design" })).not.toBeInTheDocument();
    expect(h.channelAnalytics).not.toHaveBeenCalled();
    // The channel list is no longer fetched at all for this dropdown.
    expect(h.channels).not.toHaveBeenCalled();
  });

  it("still renders a pre-existing /app/analytics/:channelId link as a graceful fallback", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.channelAnalytics.mockResolvedValue(ANALYTICS);
    h.projects.mockResolvedValue([]);
    mount(`/app/analytics/${CHANNEL_ID}`);

    // Unreachable from the dropdown now, but a bookmarked/shared link to an
    // old channel-wise dashboard must not 404 or redirect away silently.
    await waitFor(() => expect(h.channelAnalytics).toHaveBeenCalledWith(CHANNEL_ID));
    expect((await screen.findByText("Total tasks")).parentElement).toHaveTextContent("3");
  });

  it("loads selected-channel analytics through the real panel", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.channelAnalytics.mockResolvedValue(ANALYTICS);
    h.projects.mockResolvedValue([]);
    mount(`/app/analytics/${CHANNEL_ID}`);

    expect((await screen.findByText("Total tasks")).parentElement).toHaveTextContent("3");
    expect(screen.getByText("Completed tasks").parentElement).toHaveTextContent("2");
    await waitFor(() => expect(h.channelAnalytics).toHaveBeenCalledWith(CHANNEL_ID));
    // Selecting a channel must not also render the workspace overview query.
    expect(h.workspaceAnalyticsOverview).not.toHaveBeenCalled();
  });

  it("shows the workspace Overview by default, with no channel or project selected", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount("/app/analytics");

    await waitFor(() => expect(h.workspaceAnalyticsOverview).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Projects" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Overview" })).toHaveValue("");
  });

  it("exposes project selection in the header dropdown", async () => {
    h.channels.mockResolvedValue([]);
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount("/app/analytics");

    const selector = await screen.findByRole("combobox", { name: "Projects" });
    expect(await within(selector).findByRole("option", { name: "Launch Plan" })).toHaveValue(
      `project:${PROJECT_ID}`,
    );
    expect(h.projectAnalytics).not.toHaveBeenCalled();
  });

  it("lists only projects — not channels, including a project's own auto-created one", async () => {
    h.channels.mockResolvedValue([CHANNEL, { ...CHANNEL, id: PROJECT_OWN_CHANNEL_ID, name: "Launch Plan" }]);
    h.projects.mockResolvedValue([PROJECT]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount("/app/analytics");

    const selector = await screen.findByRole("combobox", { name: "Projects" });
    expect(await within(selector).findAllByRole("option", { name: /launch plan/i })).toHaveLength(1);
    expect(within(selector).queryByRole("option", { name: "Design" })).not.toBeInTheDocument();
  });

  it("loads the selected project's dashboard through the real panel, identifying the project", async () => {
    h.channels.mockResolvedValue([]);
    h.projects.mockResolvedValue([PROJECT]);
    h.projectDetail.mockResolvedValue(PROJECT);
    h.projectAnalytics.mockResolvedValue(PROJECT_ANALYTICS);
    mount(`/app/analytics/projects/${PROJECT_ID}`);

    expect(await screen.findByText("Launch Plan")).toBeInTheDocument();
    expect((await screen.findByText("Total tasks")).parentElement).toHaveTextContent("5");
    expect(screen.getByText("Completed tasks").parentElement).toHaveTextContent("4");
    await waitFor(() => expect(h.projectAnalytics).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({ offset: 0 })));
    expect(h.channelAnalytics).not.toHaveBeenCalled();
    expect(h.workspaceAnalyticsOverview).not.toHaveBeenCalled();
  });

  it("shows the workspace empty activity state when no accessible projects or channels exist", async () => {
    h.channels.mockResolvedValue([]);
    h.projects.mockResolvedValue([]);
    h.workspaceAnalyticsOverview.mockResolvedValue(EMPTY_OVERVIEW);
    mount("/app/analytics");

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });
});
