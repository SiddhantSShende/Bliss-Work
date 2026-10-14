import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ChannelDTO, type ChannelAnalyticsDTO, type ProjectAnalyticsDTO, type ProjectDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channels: vi.fn(),
  channelAnalytics: vi.fn(),
  projects: vi.fn(),
  projectDetail: vi.fn(),
  projectAnalytics: vi.fn(),
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
const PROJECT: ProjectDTO = {
  id: PROJECT_ID,
  name: "Launch Plan",
  channelId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
  it("renders the channel list", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.projects.mockResolvedValue([]);
    mount("/app/analytics");
    expect(await screen.findByRole("link", { name: /design/i })).toHaveAttribute(
      "href",
      `/app/analytics/${CHANNEL_ID}`,
    );
    expect(h.channelAnalytics).not.toHaveBeenCalled();
  });

  it("loads selected-channel analytics through the real panel", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.channelAnalytics.mockResolvedValue(ANALYTICS);
    h.projects.mockResolvedValue([]);
    mount(`/app/analytics/${CHANNEL_ID}`);

    expect((await screen.findByText("Total tasks")).parentElement).toHaveTextContent("3");
    expect(screen.getByText("Completed tasks").parentElement).toHaveTextContent("2");
    await waitFor(() => expect(h.channelAnalytics).toHaveBeenCalledWith(CHANNEL_ID));
  });

  it("shows the no-selection empty state without a channelId or projectId", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.projects.mockResolvedValue([]);
    mount("/app/analytics");

    expect(await screen.findByText("Select a channel or a project")).toBeInTheDocument();
    expect(screen.getByText("Choose a channel or a project on the left to view its analytics.")).toBeInTheDocument();
  });

  it("renders the project list", async () => {
    h.channels.mockResolvedValue([]);
    h.projects.mockResolvedValue([PROJECT]);
    mount("/app/analytics");

    expect(await screen.findByRole("link", { name: /launch plan/i })).toHaveAttribute(
      "href",
      `/app/analytics/projects/${PROJECT_ID}`,
    );
    expect(h.projectAnalytics).not.toHaveBeenCalled();
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
  });

  it("shows an empty-projects state when there are none", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.projects.mockResolvedValue([]);
    mount("/app/analytics");

    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });
});
