/**
 * The Completed category's tasks/projects toggle: completed-task cards by
 * default, completed-project cards on request, switched with no navigation
 * (no route change, no remount of the task data) and no effect on any other
 * bucket's Export/New Task controls.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({
  api: {
    taskAssigned: vi.fn(),
    taskAction: vi.fn(),
    stickyPinStates: vi.fn(),
    addTaskParticipants: vi.fn(),
    withdrawTaskParticipant: vi.fn(),
    projects: vi.fn(),
  },
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks.api, config: { kind: "web" } }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

import { Tasks } from "./Tasks";

function task(id: string, title: string, status: AssigneeStatus): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
    description: "",
    senderId: "00000000-0000-4000-8000-000000000001",
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

const ACTIVE_PROJECT = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha",
  channelId: "00000000-0000-4000-8000-000000000011",
  status: "ACTIVE",
  canComplete: false,
};
const COMPLETED_PROJECT = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Gamma",
  channelId: "00000000-0000-4000-8000-000000000012",
  status: "COMPLETED",
  canComplete: false,
};

function mount(view = "completed") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/app/tasks/${view}`]}>
        <Routes>
          <Route path="/app/tasks/:view" element={<Tasks />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  mocks.api.taskAssigned.mockReset().mockResolvedValue([task("t1", "Finish report", "COMPLETED")]);
  mocks.api.taskAction.mockReset();
  mocks.api.stickyPinStates.mockReset().mockResolvedValue([]);
  mocks.api.addTaskParticipants.mockReset();
  mocks.api.withdrawTaskParticipant.mockReset();
  mocks.api.projects.mockReset().mockResolvedValue([ACTIVE_PROJECT, COMPLETED_PROJECT]);
});

describe("Completed tasks / Completed projects toggle", () => {
  it("defaults to completed-task cards with the toggle visible", async () => {
    mount();
    expect(await screen.findByText("Finish report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completed Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Completed Projects" })).toBeInTheDocument();
  });

  it("switches to completed-project cards without navigating, and back again", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Finish report");

    await user.click(screen.getByRole("button", { name: "Completed Projects" }));
    expect(await screen.findByText("Gamma")).toBeInTheDocument();
    expect(screen.queryByText("Finish report")).not.toBeInTheDocument();
    // Only the COMPLETED project is shown in the card grid, not the ACTIVE
    // one — "Alpha" may still appear in the always-visible mobile active-
    // projects chip row, so this checks the card grid specifically.
    const grid = screen.getByText("Gamma").closest(".grid");
    expect(grid).not.toBeNull();
    expect(within(grid as HTMLElement).queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Completed Projects" })).toBeInTheDocument();
    // No task data refetch — the view is purely a client-side card swap.
    expect(mocks.api.taskAssigned).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Completed Tasks" }));
    expect(await screen.findByText("Finish report")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
  });

  it("hides New Task (and Export) on the completed-projects card grid, but keeps them for completed tasks", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Finish report");
    expect(screen.getByRole("button", { name: /New task/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Completed Projects" }));
    await screen.findByText("Gamma");
    expect(screen.queryByRole("button", { name: /New task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no completed projects", async () => {
    mocks.api.projects.mockResolvedValue([ACTIVE_PROJECT]);
    const user = userEvent.setup();
    mount();
    await screen.findByText("Finish report");
    await user.click(screen.getByRole("button", { name: "Completed Projects" }));
    expect(await screen.findByText("No completed projects")).toBeInTheDocument();
  });

  it("does not show the toggle on other buckets", async () => {
    mount("allocated");
    await waitFor(() => expect(mocks.api.taskAssigned).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Completed Tasks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Completed Projects" })).not.toBeInTheDocument();
  });
});
