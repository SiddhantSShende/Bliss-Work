/**
 * What the allocator's board shows about deadlines and missed work: a task's
 * deadline (only when it has one), an assignee who MISSED it — status, timeline
 * milestone, and a status filter that finds them — and a schedule's deadline: the
 * one absolute instant of a one-off task, or the RULE a recurring series resolves
 * for each occurrence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScheduledTaskDTO, SentTaskDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const api = {
  tasksSent: vi.fn(async () => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
  taskSchedules: vi.fn(async () => [] as ScheduledTaskDTO[]),
  channels: vi.fn(async () => []),
  addTaskParticipants: vi.fn(),
  withdrawTaskParticipant: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MyTasksBoard } from "./MyTasksBoard";

const ASSIGNED = "2026-09-19T10:00:00.000Z";
const DEADLINE = "2026-09-19T16:00:00.000Z";
const MISSED = "2026-09-19T16:00:03.000Z";

const task = (id: string, title: string, over: Record<string, unknown>, status = "SENT", assignee: Record<string, unknown> = {}) =>
  ({
    taskId: id,
    title,
    description: "",
    createdAt: ASSIGNED,
    participants: [],
    assignees: [{ assigneeId: "u-alice", assigneeUsername: "alice", status, assignedAt: ASSIGNED, ...assignee }],
    ...over,
  }) as unknown as SentTaskDTO;

const cardOf = (title: string) => screen.getByText(title).closest("div.flex-col.p-4") as HTMLElement;

const schedule = (over: Partial<ScheduledTaskDTO>) =>
  ({
    scheduleId: "00000000-0000-4000-8000-0000000000aa",
    title: "Weekly report",
    description: "",
    channelIds: [],
    kind: "SCHEDULED",
    startAt: "2026-10-01T09:00:00.000Z",
    nextRunAt: "2026-10-01T09:00:00.000Z",
    weekdays: [],
    endCondition: "NO_END",
    occurrenceCount: 0,
    assignees: [{ userId: "u-alice", username: "alice" }],
    ...over,
  }) as ScheduledTaskDTO;

/** Scheduled tasks only appear once the Scheduled status filter is on. */
async function showSchedules(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "scheduled" }));
}

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
  api.taskSchedules.mockResolvedValue([]);
});

describe("a task's deadline on the allocator's card", () => {
  it("is shown when the task has one, and not at all when it does not", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "With a deadline", { deadlineAt: DEADLINE }), task("t2", "Without one", {})]);
    renderBoard();

    await screen.findByText("With a deadline");
    const withDeadline = cardOf("With a deadline");
    expect(within(withDeadline).getByText("Deadline")).toBeInTheDocument();
    expect([...withDeadline.querySelectorAll("time")].map((t) => t.getAttribute("datetime"))).toContain(DEADLINE);
    expect(screen.getAllByText("Deadline")).toHaveLength(1); // the other card has no empty placeholder
  });
});

describe("an assignee who missed the deadline", () => {
  beforeEach(() => {
    api.tasksSent.mockResolvedValue([
      task("t1", "Missed one", { deadlineAt: DEADLINE }, "MISSED", { missedAt: MISSED }),
      task("t2", "Fine one", {}, "COMPLETED"),
    ]);
  });

  it("shows the missed status and when it was missed in their timeline", async () => {
    renderBoard();
    await screen.findByText("Missed one");
    const card = cardOf("Missed one");
    // the assignee's status badge — and the participants list repeats it, hence "all"
    expect(within(card).getAllByText("missed").length).toBeGreaterThanOrEqual(1);
    expect(within(card).getByText("Missed", { selector: "span.text-fg\\/70" })).toBeInTheDocument(); // its milestone
  });

  it("can be filtered for, like any other outcome", async () => {
    const user = renderBoard();
    await screen.findByText("Missed one");
    await user.click(screen.getByRole("button", { name: "missed" }));
    expect(screen.getByText("Missed one")).toBeInTheDocument();
    expect(screen.queryByText("Fine one")).not.toBeInTheDocument();
  });
});

describe("a schedule's deadline", () => {
  it("a one-off scheduled task shows its absolute deadline", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "x", {})]);
    api.taskSchedules.mockResolvedValue([schedule({ deadlineAt: DEADLINE })]);
    const user = renderBoard();
    await showSchedules(user);
    const card = cardOf("Weekly report");
    expect([...card.querySelectorAll("time")].map((t) => t.getAttribute("datetime"))).toEqual([DEADLINE]);
  });

  it("a recurring series shows the rule its occurrences are resolved from", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "x", {})]);
    api.taskSchedules.mockResolvedValue([
      schedule({ kind: "RECURRING", frequency: "DAILY", interval: 1, deadlineRule: { kind: "RELATIVE", amount: 6, unit: "HOURS", timeZone: "UTC" } }),
    ]);
    const user = renderBoard();
    await showSchedules(user);
    expect(await screen.findByText(/Deadline: 6 hours after each occurrence/)).toBeInTheDocument();
  });

  it("a fixed-time rule is shown as a time on each occurrence's date", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "x", {})]);
    api.taskSchedules.mockResolvedValue([
      schedule({ kind: "RECURRING", frequency: "DAILY", interval: 1, deadlineRule: { kind: "FIXED_TIME", time: "17:00", timeZone: "UTC" } }),
    ]);
    const user = renderBoard();
    await showSchedules(user);
    expect(await screen.findByText(/Deadline: .*5:00\s?PM on each occurrence's date/)).toBeInTheDocument();
  });

  it("a schedule without a deadline shows no deadline line", async () => {
    api.tasksSent.mockResolvedValue([task("t1", "x", {})]);
    api.taskSchedules.mockResolvedValue([schedule({ kind: "RECURRING", frequency: "DAILY", interval: 1 })]);
    const user = renderBoard();
    await showSchedules(user);
    await screen.findByText("Weekly report");
    expect(screen.queryByText(/Deadline/)).not.toBeInTheDocument();
  });
});
