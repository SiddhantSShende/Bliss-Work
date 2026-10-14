/**
 * ProjectWorkspace: the project page's own loading/error states, and that it
 * renders the project name and the Created-by-you / Assigned-to-you sections
 * for the real project id. The project dashboard (ProjectAnalyticsPanel) used
 * to be inlined here too; it has moved to Analytics (see Analytics.test.tsx)
 * and this page must not render it anymore.
 *
 * MyTasksBoard and ProjectAssignedTasks are each covered by their own test
 * suites already; they're stubbed here so this file stays focused on the
 * page's own wiring rather than re-exercising their internals.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectDTO } from "@taskboard/shared";

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

  it("renders the project name and both task sections for the real project id, without the dashboard", async () => {
    h.projectDetail.mockResolvedValue(PROJECT);
    mount();

    expect(await screen.findByText("Launch Plan")).toBeInTheDocument();
    expect(h.projectDetail).toHaveBeenCalledWith("proj-1");

    // The dashboard moved to Analytics — this page must no longer fetch or render it.
    expect(h.projectAnalytics).not.toHaveBeenCalled();
    expect(screen.queryByText("Project dashboard")).not.toBeInTheDocument();

    expect(screen.getByTestId("created-by-you")).toHaveTextContent("proj-1");
    expect(screen.getByTestId("assigned-to-you")).toHaveTextContent("proj-1");
  });
});
