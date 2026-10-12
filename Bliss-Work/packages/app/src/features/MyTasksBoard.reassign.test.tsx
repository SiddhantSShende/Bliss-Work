/**
 * "Reassign" on a Completed, Left, or Ignored card of the allocator's My Tasks
 * board: it appears only where the whole task is eligible, hands the task back to
 * the same people through one API call with no picker, cannot be double-submitted,
 * reports a refusal, and leaves the board showing the task as work again once the
 * server has reopened it. (Which people are restored, the status reset and the
 * history are task-svc's, and are covered by its integration tests.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type SentTaskDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { expandAllDetails } from "../test/expandDetails";
import { isReassignableTask } from "../lib/sentTaskFilter";

const api = {
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
  taskSchedules: vi.fn(async () => []),
  channels: vi.fn(async () => []),
  addTaskParticipants: vi.fn(),
  withdrawTaskParticipant: vi.fn(),
  reassignTask: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// If the board ever opened a picker for this action, it would be through this.
vi.mock("./AddParticipantsPicker", () => ({
  AddParticipantsPicker: () => <div data-testid="member-picker" />,
}));

import { MyTasksBoard } from "./MyTasksBoard";

const AT = "2026-09-19T10:00:00.000Z";
type Row = { id: string; status: string };
const task = (id: string, title: string, rows: Row[]) =>
  ({
    taskId: id,
    title,
    description: "",
    createdAt: AT,
    participants: [],
    assignees: rows.map((r) => ({ assigneeId: `u-${r.id}`, assigneeUsername: r.id, status: r.status, assignedAt: AT })),
  }) as unknown as SentTaskDTO;

const cardOf = (title: string) => screen.getByText(title).closest("[data-testid=\"task-card\"]") as HTMLElement;
const reassignIn = (title: string) => within(cardOf(title)).queryByRole("button", { name: /^Reassign/ });

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyTasksBoard />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ user: { id: "me" } } as never);
  api.reassignTask.mockResolvedValue({ taskId: "t", reassignedUserIds: ["u-alice"] });
});

describe("isReassignableTask", () => {
  const rows = (...s: string[]) => ({ assignees: s.map((status) => ({ status })) }) as unknown as SentTaskDTO;
  it("needs a completed row, or every row sharing one LEFT/IGNORED outcome, and nobody still active", () => {
    expect(isReassignableTask(rows("COMPLETED"))).toBe(true);
    expect(isReassignableTask(rows("COMPLETED", "COMPLETED"))).toBe(true);
    expect(isReassignableTask(rows("COMPLETED", "LEFT", "IGNORED", "MISSED"))).toBe(true);
    expect(isReassignableTask(rows("COMPLETED", "SENT"))).toBe(false);
    expect(isReassignableTask(rows("COMPLETED", "ACKNOWLEDGED"))).toBe(false);
    expect(isReassignableTask(rows("SENT"))).toBe(false);
    expect(isReassignableTask(rows("LEFT"))).toBe(true);
    expect(isReassignableTask(rows("LEFT", "LEFT"))).toBe(true);
    expect(isReassignableTask(rows("IGNORED"))).toBe(true);
    expect(isReassignableTask(rows("IGNORED", "IGNORED"))).toBe(true);
    expect(isReassignableTask(rows("LEFT", "IGNORED"))).toBe(false);
    expect(isReassignableTask(rows("MISSED"))).toBe(false);
    expect(isReassignableTask(rows())).toBe(false);
  });
});

describe("where Reassign appears", () => {
  it("is on completed, wholly-left, and wholly-ignored tasks; every other state is left alone", async () => {
    api.tasksSent.mockResolvedValue([
      task("done", "Finished", [{ id: "alice", status: "COMPLETED" }]),
      task("sent", "Just sent", [{ id: "alice", status: "SENT" }]),
      task("acked", "In progress", [{ id: "alice", status: "ACKNOWLEDGED" }]),
      task("left", "Walked away", [{ id: "alice", status: "LEFT" }]),
      task("ignored", "Passed over", [{ id: "alice", status: "IGNORED" }]),
      task("missed", "Too late", [{ id: "alice", status: "MISSED" }]),
      task("part", "Half done", [{ id: "alice", status: "COMPLETED" }, { id: "bob", status: "ACKNOWLEDGED" }]),
      task("split", "Split outcome", [{ id: "alice", status: "LEFT" }, { id: "bob", status: "IGNORED" }]),
    ]);
    renderBoard();
    await screen.findByText("Finished");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Split outcome");

    for (const title of ["Finished", "Walked away", "Passed over"]) {
      expect(reassignIn(title), title).toBeInTheDocument();
    }
    for (const title of ["Just sent", "In progress", "Too late", "Half done", "Split outcome"]) {
      expect(reassignIn(title), title).not.toBeInTheDocument();
    }
  });

  it("is judged on the whole task, not on the rows a filter leaves visible", async () => {
    api.tasksSent.mockResolvedValue([
      task("part", "Half done", [{ id: "alice", status: "COMPLETED" }, { id: "bob", status: "SENT" }]),
    ]);
    const user = renderBoard();
    await screen.findByText("Half done");

    await user.click(screen.getByRole("button", { name: "completed" }));
    await expandAllDetails();

    expect(within(cardOf("Half done")).queryByText("bob")).not.toBeInTheDocument();
    expect(reassignIn("Half done")).not.toBeInTheDocument();
  });
});

describe("clicking Reassign", () => {
  it("makes one call for the whole task — however many people — and opens no picker", async () => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Ship it", [{ id: "alice", status: "COMPLETED" }, { id: "bob", status: "COMPLETED" }, { id: "carol", status: "LEFT" }]),
    ]);
    api.reassignTask.mockResolvedValue({ taskId: "t1", reassignedUserIds: ["u-alice", "u-bob"] });
    const user = renderBoard();
    await screen.findByText("Ship it");

    await user.click(reassignIn("Ship it")!);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Task sent back to 2 people"));
    expect(api.reassignTask).toHaveBeenCalledExactlyOnceWith("t1");
    expect(api.addTaskParticipants).not.toHaveBeenCalled();
    expect(screen.queryByTestId("member-picker")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refetches the board, and the card stops being Completed once the server has reopened it", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "Ship it", [{ id: "alice", status: "COMPLETED" }])]);
    const user = renderBoard();
    await screen.findByText("Ship it");
    const before = api.tasksSent.mock.calls.length;
    // What the server answers once the reassignment has gone through.
    api.tasksSent.mockResolvedValue([task("t1", "Ship it", [{ id: "alice", status: "SENT" }])]);

    await user.click(reassignIn("Ship it")!);

    await waitFor(() => expect(api.tasksSent.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(reassignIn("Ship it")).not.toBeInTheDocument());
    await expandAllDetails();
    expect(within(cardOf("Ship it")).getAllByText("sent").length).toBeGreaterThan(0);
    expect(within(cardOf("Ship it")).queryAllByText("completed")).toEqual([]);
  });

  it("cannot be submitted twice by clicks that land before the first has rendered as pending", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "Ship it", [{ id: "alice", status: "COMPLETED" }])]);
    api.reassignTask.mockReturnValue(new Promise(() => {}));
    renderBoard();
    await screen.findByText("Ship it");
    const button = reassignIn("Ship it")!;

    // Synchronous, on the same node: TanStack's isPending (and so `disabled`) lags a macrotask.
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // The mutation fn runs a microtask after mutate(); by the time the button shows
    // "Reassigning…" every click has long since been handled.
    expect(await screen.findByRole("button", { name: "Reassigning…" })).toBeDisabled();
    expect(api.reassignTask).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal, keeps the card as it was, and allows another try", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "Ship it", [{ id: "alice", status: "COMPLETED" }])]);
    api.reassignTask.mockRejectedValueOnce(new ApiError(403, "only the allocator can reassign a task"));
    const user = renderBoard();
    await screen.findByText("Ship it");

    await user.click(reassignIn("Ship it")!);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't reassign this task", {
        description: "only the allocator can reassign a task",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(reassignIn("Ship it")).toBeEnabled());

    await user.click(reassignIn("Ship it")!);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(api.reassignTask).toHaveBeenCalledTimes(2);
  });
});
