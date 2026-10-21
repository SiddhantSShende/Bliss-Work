/**
 * "Re-add" on one participant row — the member-level counterpart to
 * `ReassignTaskButton` (MyTasksBoard.reassign.test.tsx). It lets one person who
 * ignored, left, or completed their part come back onto a task the rest of the
 * team is still actively working, without waiting for the whole task to finish
 * and without touching anyone else's status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type SentTaskDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { expandAllDetails } from "../test/expandDetails";

const api = {
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
  taskSchedules: vi.fn(async () => []),
  channels: vi.fn(async () => []),
  addTaskParticipants: vi.fn(),
  withdrawTaskParticipant: vi.fn(),
  reassignTask: vi.fn(),
  reassignTaskMember: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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

const cardOf = (title: string) => screen.getByText(title).closest('[data-testid="task-card"]') as HTMLElement;
const reAddFor = (title: string, person: string) =>
  within(within(cardOf(title)).getByText(person).closest("li") as HTMLElement).queryByRole("button", { name: /^Re-add/ });
const taskWideReassignIn = (title: string) => within(cardOf(title)).queryByRole("button", { name: /^Reassign/ });

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
  api.reassignTaskMember.mockResolvedValue({ taskId: "t", assigneeId: "u-divya" });
});

describe("where member-level Re-add appears", () => {
  it("is on an ignored/left/completed row while the task is still active, and never on an active row", async () => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Shared task", [
        { id: "divya", status: "IGNORED" },
        { id: "bob", status: "ACKNOWLEDGED" },
      ]),
    ]);
    renderBoard();
    await screen.findByText("Shared task");
    await expandAllDetails();

    expect(reAddFor("Shared task", "divya")).toBeInTheDocument();
    expect(reAddFor("Shared task", "bob")).not.toBeInTheDocument();
    // The task overall is not reassignable (bob is still active): no task-wide button either.
    expect(taskWideReassignIn("Shared task")).not.toBeInTheDocument();
  });

  it("does not duplicate the task-wide button once the whole task is already reassignable", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "Done deal", [{ id: "divya", status: "COMPLETED" }])]);
    renderBoard();
    await screen.findByText("Done deal");
    await expandAllDetails();

    expect(taskWideReassignIn("Done deal")).toBeInTheDocument();
    expect(reAddFor("Done deal", "divya")).not.toBeInTheDocument();
  });
});

describe("clicking Re-add", () => {
  it("reassigns only that one member, by id, and leaves the board to refetch", async () => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Shared task", [
        { id: "divya", status: "IGNORED" },
        { id: "bob", status: "ACKNOWLEDGED" },
      ]),
    ]);
    const user = renderBoard();
    await screen.findByText("Shared task");
    await expandAllDetails();

    await user.click(reAddFor("Shared task", "divya")!);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("divya is back on this task"));
    expect(api.reassignTaskMember).toHaveBeenCalledExactlyOnceWith("t1", "u-divya");
    expect(api.reassignTask).not.toHaveBeenCalled();
  });

  it("cannot be submitted twice by clicks landing before the first renders as pending", async () => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Shared task", [{ id: "divya", status: "LEFT" }, { id: "bob", status: "ACKNOWLEDGED" }]),
    ]);
    api.reassignTaskMember.mockReturnValue(new Promise(() => {}));
    renderBoard();
    await screen.findByText("Shared task");
    await expandAllDetails();
    const button = reAddFor("Shared task", "divya")!;

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole("button", { name: "Re-adding…" })).toBeDisabled();
    expect(api.reassignTaskMember).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and allows another try", async () => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Shared task", [{ id: "divya", status: "IGNORED" }, { id: "bob", status: "ACKNOWLEDGED" }]),
    ]);
    api.reassignTaskMember.mockRejectedValueOnce(new ApiError(409, "member has nothing to reassign"));
    const user = renderBoard();
    await screen.findByText("Shared task");
    await expandAllDetails();

    await user.click(reAddFor("Shared task", "divya")!);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't re-add this person", {
        description: "member has nothing to reassign",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(reAddFor("Shared task", "divya")).toBeEnabled());

    await user.click(reAddFor("Shared task", "divya")!);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(api.reassignTaskMember).toHaveBeenCalledTimes(2);
  });
});
