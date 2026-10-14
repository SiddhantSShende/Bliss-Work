import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  api: {
    projects: vi.fn(),
    taskAssigned: vi.fn(),
    tasksSent: vi.fn(),
  },
}));

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../lib/useAvailability", () => ({ useAvailability: () => ({ roster: [] }) }));
vi.mock("../lib/useDeadlineRefetch", () => ({ useDeadlineRefetch: () => {} }));
vi.mock("../lib/useMarkTaskNotificationsRead", () => ({ useMarkTaskNotificationsRead: () => {} }));

import { TasksList } from "./TasksList";

const PROJECTS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Alpha",
    channelId: "00000000-0000-4000-8000-000000000011",
    status: "ACTIVE",
    canComplete: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Beta",
    channelId: "00000000-0000-4000-8000-000000000012",
    status: "ACTIVE",
    canComplete: false,
  },
];

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/tasks/mine"]}>
        <TasksList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.api.projects.mockReset().mockResolvedValue(PROJECTS);
  h.api.taskAssigned.mockReset().mockResolvedValue([]);
  h.api.tasksSent.mockReset().mockResolvedValue([]);
});

describe("TasksList project section", () => {
  it("shows one link per project above the existing task categories", async () => {
    mount();
    const projectsHeading = await screen.findByText("Projects");
    const projectLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.includes("/tasks/projects/"));
    expect(projectLinks).toHaveLength(2);
    expect(projectLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/app/tasks/projects/00000000-0000-4000-8000-000000000001",
      "/app/tasks/projects/00000000-0000-4000-8000-000000000002",
    ]);
    const myTasks = screen.getByRole("link", { name: "My tasks" });
    expect(projectsHeading.compareDocumentPosition(myTasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the Projects section when no projects exist", async () => {
    h.api.projects.mockResolvedValue([]);
    mount();
    await waitFor(() => expect(h.api.projects).toHaveBeenCalledOnce());
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My tasks" })).toBeInTheDocument();
  });
});

describe("TasksList completed projects", () => {
  const COMPLETED_PROJECT = {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Gamma",
    channelId: "00000000-0000-4000-8000-000000000013",
    status: "COMPLETED",
    canComplete: false,
  };

  it("keeps a completed project out of the active Projects section, under Completed instead", async () => {
    h.api.projects.mockResolvedValue([...PROJECTS, COMPLETED_PROJECT]);
    mount();

    await screen.findByText("Projects");
    const projectLinks = screen.getAllByRole("link").filter((link) =>
      link.getAttribute("href")?.includes("/tasks/projects/"),
    );
    // Only the two ACTIVE projects (Alpha, Beta) are listed under "Projects".
    expect(projectLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/app/tasks/projects/00000000-0000-4000-8000-000000000001",
      "/app/tasks/projects/00000000-0000-4000-8000-000000000002",
      "/app/tasks/projects/00000000-0000-4000-8000-000000000003",
    ]);

    // Gamma (completed) is positioned after the "Completed" category link, not
    // among the active Projects rows, and never shows up twice.
    const completedCat = screen.getByRole("link", { name: "Completed" });
    const gammaLink = screen.getByRole("link", { name: "Gamma" });
    expect(completedCat.compareDocumentPosition(gammaLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("Gamma")).toHaveLength(1);
  });

  it("hides the completed-projects sub-list when there are none", async () => {
    h.api.projects.mockResolvedValue(PROJECTS);
    mount();
    await screen.findByText("Projects");
    expect(screen.queryByRole("link", { name: "Gamma" })).not.toBeInTheDocument();
  });

  it("moves a project to Completed as soon as qk.projects is invalidated, with no remount", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.api.projects.mockResolvedValueOnce(PROJECTS);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/app/tasks/mine"]}>
          <TasksList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("link", { name: "Alpha" });
    expect(screen.queryByRole("link", { name: "Gamma" })).not.toBeInTheDocument();

    // CompleteProjectButton's onSuccess does exactly this: invalidate qk.projects
    // so the next refetch picks up the server's new status. No component remount.
    h.api.projects.mockResolvedValueOnce([...PROJECTS, COMPLETED_PROJECT]);
    await queryClient.invalidateQueries({ queryKey: ["projects"] });

    const gammaLink = await screen.findByRole("link", { name: "Gamma" });
    const completedCat = screen.getByRole("link", { name: "Completed" });
    expect(completedCat.compareDocumentPosition(gammaLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("returns a reopened project to the Projects section and out of Completed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.api.projects.mockResolvedValueOnce([...PROJECTS, COMPLETED_PROJECT]);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/app/tasks/mine"]}>
          <TasksList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("link", { name: "Gamma" })).toBeInTheDocument();

    // The project is reopened server-side (status flips back to ACTIVE) and
    // the list is refetched — the UI derives its bucket purely from the
    // current `status` field, so it moves back with no special-casing.
    h.api.projects.mockResolvedValueOnce([...PROJECTS, { ...COMPLETED_PROJECT, status: "ACTIVE" }]);
    await queryClient.invalidateQueries({ queryKey: ["projects"] });

    const gammaLink = await screen.findByRole("link", { name: "Gamma" });
    const projectsHeading = screen.getByText("Projects");
    expect(projectsHeading.compareDocumentPosition(gammaLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const completedCat = screen.getByRole("link", { name: "Completed" });
    expect(gammaLink.compareDocumentPosition(completedCat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
