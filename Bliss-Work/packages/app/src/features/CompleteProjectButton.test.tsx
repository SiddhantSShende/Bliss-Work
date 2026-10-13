/**
 * Visibility, confirmation, and the mutation itself for the "Complete Project"
 * button. The server is the one authority on both permissions and task
 * completion (see task-svc's projects_write.py) — these tests only cover what
 * the client offers and how it reacts to the server's answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ProjectAnalyticsDTO, ProjectDTO } from "@taskboard/shared";
import { ApiError } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  api: {
    projectAnalytics: vi.fn(),
    completeProject: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CompleteProjectButton } from "./CompleteProjectButton";

const ACTIVE: ProjectDTO = {
  id: "proj-1",
  name: "Launch Plan",
  channelId: "chan-1",
  status: "ACTIVE",
  canComplete: true,
};

function analytics(overrides: Partial<ProjectAnalyticsDTO["completion"]> = {}): ProjectAnalyticsDTO {
  return {
    projectId: "proj-1",
    statusBreakdown: { sent: 0, acknowledged: 0, completed: 0, ignored: 0, left: 0, missed: 0 },
    completion: {
      totalAssignments: 0,
      completedAssignments: 0,
      assignmentCompletionRate: 0,
      totalUniqueTasks: 2,
      completedUniqueTasks: 2,
      abandonedUniqueTasks: 0,
      remainingUniqueTasks: 0,
      uniqueTaskCompletionRate: 100,
      ...overrides,
    },
    workload: [],
    overdueUniqueTasks: 0,
    tasks: [],
    tasksOffset: 0,
    tasksLimit: 1,
    tasksTotal: 2,
  };
}

function mount(project: ProjectDTO) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CompleteProjectButton project={project} />
    </QueryClientProvider>,
  );
  return { qc, user: userEvent.setup() };
}

const triggerBtn = () => screen.queryByRole("button", { name: "Complete Project" });

beforeEach(() => {
  h.api.projectAnalytics.mockReset();
  h.api.completeProject.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe("visibility", () => {
  it("shown once every task is completed, for the owner", async () => {
    h.api.projectAnalytics.mockResolvedValue(analytics());
    mount(ACTIVE);
    expect(await screen.findByRole("button", { name: "Complete Project" })).toBeInTheDocument();
    expect(h.api.projectAnalytics).toHaveBeenCalledWith("proj-1", { limit: 1, offset: 0 });
  });

  it("hidden while any task remains incomplete", async () => {
    h.api.projectAnalytics.mockResolvedValue(analytics({ remainingUniqueTasks: 1, completedUniqueTasks: 1 }));
    mount(ACTIVE);
    await waitFor(() => expect(h.api.projectAnalytics).toHaveBeenCalled());
    expect(triggerBtn()).not.toBeInTheDocument();
  });

  it("hidden for a wholly abandoned task — not completed, not a reason to close the project", async () => {
    h.api.projectAnalytics.mockResolvedValue(
      analytics({ completedUniqueTasks: 1, abandonedUniqueTasks: 1, totalUniqueTasks: 2, remainingUniqueTasks: 0 }),
    );
    mount(ACTIVE);
    await waitFor(() => expect(h.api.projectAnalytics).toHaveBeenCalled());
    expect(triggerBtn()).not.toBeInTheDocument();
  });

  it("hidden for a project with no tasks", async () => {
    h.api.projectAnalytics.mockResolvedValue(analytics({ totalUniqueTasks: 0, completedUniqueTasks: 0 }));
    mount(ACTIVE);
    await waitFor(() => expect(h.api.projectAnalytics).toHaveBeenCalled());
    expect(triggerBtn()).not.toBeInTheDocument();
  });

  it("hidden for someone who is neither the owner nor an org_admin — never even fetches eligibility", () => {
    mount({ ...ACTIVE, canComplete: false });
    expect(triggerBtn()).not.toBeInTheDocument();
    expect(h.api.projectAnalytics).not.toHaveBeenCalled();
  });

  it("hidden once the project is already completed", () => {
    mount({ ...ACTIVE, status: "COMPLETED" });
    expect(triggerBtn()).not.toBeInTheDocument();
    expect(h.api.projectAnalytics).not.toHaveBeenCalled();
  });
});

describe("completing", () => {
  beforeEach(() => {
    h.api.projectAnalytics.mockResolvedValue(analytics());
  });

  it("asks for confirmation before calling the API", async () => {
    const { user } = mount(ACTIVE);
    await user.click(await screen.findByRole("button", { name: "Complete Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this project?" });
    expect(dialog).toHaveTextContent("Every task in this project is complete");
    expect(h.api.completeProject).not.toHaveBeenCalled();
  });

  it("backing out completes nothing", async () => {
    const { user } = mount(ACTIVE);
    await user.click(await screen.findByRole("button", { name: "Complete Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this project?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(h.api.completeProject).not.toHaveBeenCalled();
  });

  it("disables the confirm button while the request is in flight, preventing a duplicate submission", async () => {
    let resolve!: (value: ProjectDTO) => void;
    h.api.completeProject.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { user } = mount(ACTIVE);
    await user.click(await screen.findByRole("button", { name: "Complete Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this project?" });
    const confirmBtn = within(dialog).getByRole("button", { name: "Complete Project" });

    await user.click(confirmBtn);
    expect(h.api.completeProject).toHaveBeenCalledTimes(1);
    await user.click(confirmBtn);
    expect(h.api.completeProject).toHaveBeenCalledTimes(1); // still in flight: no second call

    resolve({ ...ACTIVE, status: "COMPLETED" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("on success, updates the cached project and tells the caller", async () => {
    h.api.completeProject.mockResolvedValue({ ...ACTIVE, status: "COMPLETED" });
    const { qc, user } = mount(ACTIVE);
    await user.click(await screen.findByRole("button", { name: "Complete Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this project?" });
    await user.click(within(dialog).getByRole("button", { name: "Complete Project" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Project marked as completed."));
    expect(qc.getQueryData(["projects", "proj-1"])).toEqual({ ...ACTIVE, status: "COMPLETED" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a failure says so, keeps the dialog open to retry, and does not pretend to succeed", async () => {
    h.api.completeProject.mockRejectedValue(new ApiError(409, "project has tasks that are not completed"));
    const { user } = mount(ACTIVE);
    await user.click(await screen.findByRole("button", { name: "Complete Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this project?" });
    await user.click(within(dialog).getByRole("button", { name: "Complete Project" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not complete the project.", {
        description: "project has tasks that are not completed",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Complete this project?" })).toBeInTheDocument();
  });
});
