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

  // Completed projects no longer appear in the sidebar at all (active or
  // completed) — they surface as cards in the Tasks page's "Completed
  // Projects" view instead (see Tasks.completedProjects.test.tsx).
  it("never lists a completed project in the sidebar, under Projects or under Completed", async () => {
    h.api.projects.mockResolvedValue([...PROJECTS, COMPLETED_PROJECT]);
    mount();

    await screen.findByText("Projects");
    const projectLinks = screen.getAllByRole("link").filter((link) =>
      link.getAttribute("href")?.includes("/tasks/projects/"),
    );
    // Only the two ACTIVE projects (Alpha, Beta) are listed.
    expect(projectLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/app/tasks/projects/00000000-0000-4000-8000-000000000001",
      "/app/tasks/projects/00000000-0000-4000-8000-000000000002",
    ]);
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
  });
});
