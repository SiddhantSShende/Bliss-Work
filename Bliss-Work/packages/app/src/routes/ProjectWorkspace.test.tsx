/**
 * ProjectWorkspace: the project page's own loading/error states, and that the
 * project dashboard (ProjectAnalyticsPanel, real component — this is the new
 * integration under test) renders real backend data for the project's id
 * alongside the existing Created-by-you / Assigned-to-you sections.
 *
 * MyTasksBoard and ProjectAssignedTasks are each covered by their own test
 * suites already; they're stubbed here so this file stays focused on the
 * page's own wiring rather than re-exercising their internals.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectAnalyticsDTO, ProjectDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  projectDetail: vi.fn(),
  projectAnalytics: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));
vi.mock("../features/MyTasksBoard", () => ({
  MyTasksBoard: ({ projectId }: { projectId?: string }) => <div data-testid="created-by-you">{projectId}</div>,
}));
vi.mock("./Tasks", () => ({
  ProjectAssignedTasks: ({ projectId }: { projectId?: string }) => <div data-testid="assigned-to-you">{projectId}</div>,
}));

import { ProjectWorkspace } from "./ProjectWorkspace";

const PROJECT: ProjectDTO = {
  id: "proj-1",
  name: "Launch Plan",
  channelId: "chan-1",
  status: "ACTIVE",
  canComplete: false,
};

const ANALYTICS: ProjectAnalyticsDTO = {
  projectId: "proj-1",
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

function mount(projectId = "proj-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/tasks/projects/${projectId}`]}>
        <Routes>
          <Route path="/app/tasks/projects/:projectId" element={<ProjectWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectWorkspace", () => {
  it("shows a spinner while the project loads", () => {
    h.projectDetail.mockReturnValue(new Promise(() => {}));
    mount();
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("shows an unavailable state when the project fails to load", async () => {
    h.projectDetail.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText(/project/i)).toBeInTheDocument();
  });

  it("renders the project name, dashboard metrics, and both task sections for the real project id", async () => {
    h.projectDetail.mockResolvedValue(PROJECT);
    h.projectAnalytics.mockResolvedValue(ANALYTICS);
    mount();

    expect(await screen.findByText("Launch Plan")).toBeInTheDocument();
    expect(h.projectDetail).toHaveBeenCalledWith("proj-1");

    // The dashboard is the real ProjectAnalyticsPanel, fed by the real project id.
    expect(await screen.findByText("5")).toBeInTheDocument(); // totalUniqueTasks KPI
    expect(h.projectAnalytics).toHaveBeenCalledWith("proj-1", expect.objectContaining({ offset: 0 }));

    expect(screen.getByTestId("created-by-you")).toHaveTextContent("proj-1");
    expect(screen.getByTestId("assigned-to-you")).toHaveTextContent("proj-1");
  });
});
