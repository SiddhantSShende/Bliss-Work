import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserDTO, type ChannelDTO, type ScheduledTaskDTO, type SentTaskDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { trackUnhandledRejections } from "../test/unhandledRejections";
import { CHANNELS, DESIGN, GENERAL } from "../test/meetingFixtures";
import { pagedChannels, pagedDirectory, stubScrollGeometry } from "../test/pagedPickerApi";
import { expandAllDetails } from "../test/expandDetails";

// A plain object, not UserDTO.parse(id): these ids match the fixture's non-UUID
// SentTaskDTO.assigneeId values below, so the filter's id-based matching lines up.
const person = (id: string, username: string): UserDTO =>
  ({
    id, orgId: "00000000-0000-4000-8000-000000000999", orgName: "Acme", username, displayName: username,
    email: `${username}@acme.test`, roles: ["member"], avatarUrl: null, mfaEnrolled: false,
    orgRequireMfaForAdmins: false, orgMfaGracePeriodEndsAt: null, themePrefs: null,
  }) as UserDTO;
const ALICE = person("u-alice", "alice");
const BOB = person("u-bob", "bob");
const CAROL = person("u-carol", "carol");

const api = {
  tasksSent: vi.fn(async (_params?: { limit?: number; offset?: number; includeIgnored?: boolean }) => [] as SentTaskDTO[]),
  directory: vi.fn(async () => []),
  directoryPage: vi.fn(pagedDirectory([ALICE, BOB, CAROL])),
  taskSchedules: vi.fn(async () => [] as ScheduledTaskDTO[]),
  channels: vi.fn(async () => CHANNELS as ChannelDTO[]),
  channelsPage: vi.fn(pagedChannels(CHANNELS as ChannelDTO[])),
  channelMembers: vi.fn(async (_channelId: string) => [] as string[]),
  addTaskParticipants: vi.fn(async (_taskId: string, targets: { userIds?: string[]; channelIds?: string[] }) => ({
    addedUserIds: targets.userIds ?? [],
    addedChannelIds: targets.channelIds ?? [],
  })),
  withdrawTaskParticipant: vi.fn(async (_taskId: string, userId: string) => ({ withdrawnUserId: userId, statusVersion: 1 })),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
// The picker searches the directory; the board only cares which ids come back.
vi.mock("./AddParticipantsPicker", () => ({
  AddParticipantsPicker: (p: { onConfirm: (targets: { userIds: string[]; channelIds: string[] }) => void; busy?: boolean }) => (
    <button type="button" disabled={p.busy} onClick={() => p.onConfirm({ userIds: ["u-new"], channelIds: ["c-new"] })}>
      pick a member
    </button>
  ),
}));
// The dialog has its own behaviour; what matters here is what the board hands it.
vi.mock("./CreateReviewDialog", () => ({
  CreateReviewDialog: (p: { assigneeId: string; existingText?: string | null; existingRating?: number | null }) => (
    <div data-testid="review-dialog">
      {p.assigneeId}|{p.existingText}|{p.existingRating}
    </div>
  ),
}));

import { MyTasksBoard } from "./MyTasksBoard";

const NOW = new Date(2026, 8, 15, 12);
const at = (day: number) => new Date(2026, 8, day, 10).toISOString();

const sentTasks = [
  {
    taskId: "t1", title: "Ship the release", description: "", createdAt: at(1),
    assignees: [
      { assigneeId: "u-alice", assigneeUsername: "alice", status: "COMPLETED", assignedAt: at(10), review: null, reviewRating: null },
      { assigneeId: "u-bob", assigneeUsername: "bob", status: "IGNORED", assignedAt: at(10) },
    ],
  },
  {
    taskId: "t2", title: "Write the docs", description: "", createdAt: at(2),
    assignees: [
      { assigneeId: "u-carol", assigneeUsername: "carol", status: "COMPLETED", assignedAt: at(12), review: "Solid work", reviewRating: 4 },
    ],
  },
  {
    taskId: "t3", title: "Fix the flaky test", description: "", createdAt: at(3), participants: [],
    assignees: [{ assigneeId: "u-alice", assigneeUsername: "alice", status: "SENT", assignedAt: at(12) }],
  },
] as unknown as SentTaskDTO[];

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MyTasksBoard />
    </QueryClientProvider>,
  );
}
const titles = () => ["Ship the release", "Write the docs", "Fix the flaky test"].filter((t) => screen.queryByText(t));
const dayButton = (day: number) =>
  screen.getByRole("button", { name: new Date(2026, 8, day).toLocaleDateString(undefined, { dateStyle: "full" }) });

let restoreGeometry: () => void;
const channelsBox = () => screen.findByLabelText("Channels to filter by");
const openChannelsTab = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("tab", { name: /^Channels/ }));
const openPeopleTab = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("tab", { name: /^People/ }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  restoreGeometry = stubScrollGeometry();
  api.tasksSent.mockResolvedValue(sentTasks);
});
afterEach(() => {
  vi.useRealTimers();
  restoreGeometry();
});

describe("MyTasksBoard loading", () => {
  it("shows a loading state, not the empty state, while the first page is on its way", async () => {
    api.tasksSent.mockReturnValue(new Promise(() => {}));
    renderBoard();

    expect(await screen.findByText("Loading your tasks…")).toBeInTheDocument();
    expect(screen.queryByText("You haven't sent any tasks")).not.toBeInTheDocument();
  });

  it("says so, with a Retry, when the first load fails — and recovers on retry", async () => {
    const user = userEvent.setup();
    api.tasksSent.mockRejectedValueOnce(new Error("offline"));
    renderBoard();

    expect(await screen.findByText("Couldn't load your tasks.")).toBeInTheDocument();
    expect(screen.queryByText("You haven't sent any tasks")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ship the release")).toBeInTheDocument();
  });

  it("shows the empty state only once a load has finished with no tasks", async () => {
    api.tasksSent.mockResolvedValue([]);
    renderBoard();

    expect(await screen.findByText("You haven't sent any tasks")).toBeInTheDocument();
    expect(screen.queryByText("Loading your tasks…")).not.toBeInTheDocument();
  });
});

describe("MyTasksBoard data", () => {
  it("asks the server for ignored assignees, which /tasks/sent otherwise hides from the sender", async () => {
    renderBoard();
    await screen.findByText("Ship the release");

    expect(api.tasksSent).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, includeIgnored: true }));
  });

  it("does not show a project empty state while later task pages may contain its tasks", async () => {
    const projectId = "project-1";
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...sentTasks[0],
      taskId: `other-${index}`,
      title: `Other project task ${index}`,
      projectId: "another-project",
    })) as unknown as SentTaskDTO[];
    const laterTask = {
      ...sentTasks[0],
      taskId: "project-task",
      title: "Task on a later page",
      projectId,
    } as unknown as SentTaskDTO;
    api.tasksSent.mockImplementation(async ({ offset = 0 } = {}) =>
      offset === 0 ? firstPage : [laterTask],
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MyTasksBoard projectId={projectId} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Load more" })).toBeInTheDocument();
    expect(screen.queryByText("No tasks for this project yet")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Task on a later page")).toBeInTheDocument();
    expect(api.tasksSent).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 100, includeIgnored: true }),
    );
  });
});

describe("MyTasksBoard filters", () => {
  it("shows every task, then narrows by status, person and calendar day together", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");
    expect(titles()).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "completed" }));
    expect(titles()).toEqual(["Ship the release", "Write the docs"]);

    await user.click(await screen.findByRole("checkbox", { name: /alice$/ }));
    expect(titles()).toEqual(["Ship the release"]);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toHaveLength(3);
  });

  it("selecting channels filters by the union of their members, and unticking one keeps what the other still contributes", async () => {
    const user = userEvent.setup();
    // alice is in both channels; carol only in design; bob in neither.
    api.channelMembers.mockImplementation(async (id: string) => (id === GENERAL.id ? ["u-alice"] : ["u-alice", "u-carol"]));
    renderBoard();
    await screen.findByText("Ship the release");
    await openChannelsTab(user);
    const channelList = await channelsBox();

    await user.click(within(channelList).getByRole("checkbox", { name: /^general/ }));
    await waitFor(() => expect(titles()).toEqual(["Ship the release", "Fix the flaky test"]));
    // alice shows as ticked because of the channel, but only as a derived tick,
    // nothing in the explicit selection.
    await openPeopleTab(user);
    expect(await screen.findByRole("checkbox", { name: /alice$/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /alice$/ })).toHaveAccessibleDescription("Selected through a channel");

    await openChannelsTab(user);
    await user.click(within(channelList).getByRole("checkbox", { name: /^design/ }));
    await waitFor(() => expect(titles()).toHaveLength(3));

    // design out: carol goes with it, alice stays because general still contributes her.
    await user.click(within(channelList).getByRole("checkbox", { name: /^design/ }));
    await waitFor(() => expect(titles()).toEqual(["Ship the release", "Fix the flaky test"]));
    await user.click(within(channelList).getByRole("checkbox", { name: /^general/ }));
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(api.channelMembers).toHaveBeenCalledWith(GENERAL.id);
    expect(api.channelMembers).toHaveBeenCalledWith(DESIGN.id);
  });

  it("a channel whose members are still loading never shows the unfiltered list, and applies as soon as they arrive", async () => {
    const user = userEvent.setup();
    let arrive!: (ids: string[]) => void;
    api.channelMembers.mockImplementation(() => new Promise<string[]>((resolve) => (arrive = resolve)));
    renderBoard();
    await screen.findByText("Ship the release");
    expect(titles()).toHaveLength(3);

    await openChannelsTab(user);
    const channelList = await channelsBox();
    await user.click(within(channelList).getByRole("checkbox", { name: /^general/ }));
    await waitFor(() => expect(api.channelMembers).toHaveBeenCalledWith(GENERAL.id));
    expect(titles()).toEqual([]);

    arrive(["u-carol"]);
    await waitFor(() => expect(titles()).toEqual(["Write the docs"]));
    // carol shows as ticked in the People list because of the channel.
    await openPeopleTab(user);
    expect(await screen.findByRole("checkbox", { name: /carol$/ })).toBeChecked();
  });

  it("no explicit people + a selected channel whose member request fails must not silently show the unfiltered list", async () => {
    const user = userEvent.setup();
    api.channelMembers.mockRejectedValueOnce(new Error("503"));
    renderBoard();
    await screen.findByText("Ship the release");
    expect(titles()).toHaveLength(3);

    await openChannelsTab(user);
    const channelList = await channelsBox();
    const general = within(channelList).getByRole("checkbox", { name: /^general/ });
    await user.click(general);

    // The channel is still ticked, so it still filters: no tasks, and the panel says why.
    expect(await screen.findByText("Couldn't load the members of general, so no tasks are shown.")).toBeInTheDocument();
    expect(general).toBeChecked();
    expect(titles()).toEqual([]);

    // Retry re-requests it; once the members arrive the restriction resolves normally.
    api.channelMembers.mockResolvedValueOnce(["u-carol"]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(titles()).toEqual(["Write the docs"]));
    expect(screen.queryByText(/Couldn't load the members/)).not.toBeInTheDocument();
  });

  it("uses the calendar as a date filter, and picking the day again clears it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");

    await user.click(dayButton(12));
    expect(titles()).toEqual(["Write the docs", "Fix the flaky test"]);
    expect(dayButton(12)).toHaveAttribute("aria-pressed", "true");

    await user.click(dayButton(12));
    expect(titles()).toHaveLength(3);
    expect(within(dayButton(10)).getByTestId("task-day-mark")).toBeInTheDocument();
  });

  it("finds an ignored assignee with the Ignored chip", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Ship the release");
    await user.click(screen.getByRole("button", { name: "ignored" }));
    expect(titles()).toEqual(["Ship the release"]);
    expect(screen.queryByRole("button", { name: /write review/i })).not.toBeInTheDocument();
  });
});

describe("MyTasksBoard reviews", () => {
  it("offers Write review on a completed task without one and Edit review on one with a review", async () => {
    renderBoard();
    await screen.findByText("Ship the release");
    await expandAllDetails();
    expect(screen.getAllByRole("button", { name: /write review/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /edit review/i })).toHaveLength(1);
  });

  it("hands the review dialog the live assignee's existing review", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write the docs");
    await expandAllDetails();
    await user.click(screen.getByRole("button", { name: /edit review/i }));
    expect(screen.getByTestId("review-dialog")).toHaveTextContent("u-carol|Solid work|4");
  });
});

describe("MyTasksBoard participants", () => {
  beforeEach(() => useSession.setState({ user: { id: "u-me" } as never }));
  afterEach(() => useSession.setState({ user: null }));

  it("shows a labelled Withdraw only for the active assignee and one Add member on that card", async () => {
    renderBoard();
    await screen.findByText("Fix the flaky test");
    await expandAllDetails();

    // t3's alice is SENT. Completed (alice, carol on t1/t2) and ignored (bob) people get no Withdraw,
    // and t1/t2 have no open assignment to add to.
    const withdraw = screen.getAllByRole("button", { name: /^Withdraw / });
    expect(withdraw.map((b) => b.getAttribute("aria-label"))).toEqual(["Withdraw alice"]);
    // The visible label is just "Withdraw" — the name is reserved for the aria-label above.
    expect(withdraw[0]).toHaveTextContent(/^Withdraw$/);
    expect(screen.getAllByRole("button", { name: "Add member" })).toHaveLength(1);
  });

  it("withdraws through the API and refetches the sent list", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Fix the flaky test");
    await expandAllDetails();
    const before = api.tasksSent.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Withdraw alice" }));

    expect(api.withdrawTaskParticipant).toHaveBeenCalledWith("t3", "u-alice");
    await waitFor(() => expect(api.tasksSent.mock.calls.length).toBeGreaterThan(before));
  });

  it("adds a member through the API, closes the picker and refetches the sent list", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Fix the flaky test");
    await expandAllDetails();
    const before = api.tasksSent.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Add member" }));
    await user.click(await screen.findByRole("button", { name: "pick a member" }));

    expect(api.addTaskParticipants).toHaveBeenCalledWith("t3", { userIds: ["u-new"], channelIds: ["c-new"] });
    await waitFor(() => expect(api.tasksSent.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("button", { name: "pick a member" })).not.toBeInTheDocument());
  });

  it("toasts a failed withdraw once, leaves the list alone and leaves no rejection unhandled", async () => {
    const rejections = trackUnhandledRejections();
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 1);
    try {
      const user = userEvent.setup();
      api.withdrawTaskParticipant.mockRejectedValueOnce(new Error("boom"));
      renderBoard();
      await screen.findByText("Fix the flaky test");
      await expandAllDetails();
      const before = api.tasksSent.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Withdraw alice" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));

      expect(toastError).toHaveBeenCalledWith("Could not update participants", { description: "Error: boom" });
      expect(await rejections.unhandled()).toEqual([]);
      expect(api.tasksSent.mock.calls.length).toBe(before);
      expect(screen.getByRole("button", { name: "Withdraw alice" })).toBeEnabled();
    } finally {
      rejections.stop();
      toastError.mockRestore();
    }
  });

  it("toasts a failed add once, keeps the picker open and usable, and leaves no rejection unhandled", async () => {
    const rejections = trackUnhandledRejections();
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 1);
    try {
      const user = userEvent.setup();
      api.addTaskParticipants.mockRejectedValueOnce(new Error("boom"));
      renderBoard();
      await screen.findByText("Fix the flaky test");
      await expandAllDetails();
      const before = api.tasksSent.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Add member" }));
      await user.click(await screen.findByRole("button", { name: "pick a member" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));

      expect(toastError).toHaveBeenCalledWith("Could not update participants", { description: "Error: boom" });
      expect(await rejections.unhandled()).toEqual([]);
      expect(api.tasksSent.mock.calls.length).toBe(before);
      // Still open, and no longer busy, so the user can retry.
      await waitFor(() => expect(screen.getByRole("button", { name: "pick a member" })).toBeEnabled());
    } finally {
      rejections.stop();
      toastError.mockRestore();
    }
  });
});

describe("MyTasksBoard scheduled assignments", () => {
  const scheduled = (over: Partial<ScheduledTaskDTO>): ScheduledTaskDTO => ({
    scheduleId: "00000000-0000-4000-8000-0000000000a1",
    title: "Weekly report",
    description: "",
    channelIds: [],
    kind: "SCHEDULED",
    scheduledFor: at(20),
    startAt: at(20),
    nextRunAt: at(20),
    weekdays: [],
    endCondition: "NO_END",
    occurrenceCount: 0,
    assignees: [],
    ...over,
  });
  const people = [
    { userId: "u-alice", username: "alice" },
    { userId: "u-bob", username: "bob" },
  ];

  async function showScheduled(schedule: ScheduledTaskDTO) {
    api.taskSchedules.mockResolvedValue([schedule]);
    renderBoard();
    await userEvent.setup().click(await screen.findByRole("button", { name: "scheduled" }));
    return await screen.findByText("Weekly report");
  }

  it("shows the named people AND every channel of a mixed assignment, by name", async () => {
    await showScheduled(scheduled({ assignees: people, channelId: GENERAL.id, channelIds: [GENERAL.id, DESIGN.id] }));

    expect(screen.getByText("alice, bob")).toBeInTheDocument();
    expect(screen.getByText("Channels: #general, #design")).toBeInTheDocument();
  });

  it("shows a channel-only assignment with no people line", async () => {
    await showScheduled(scheduled({ channelId: DESIGN.id, channelIds: [DESIGN.id] }));

    expect(screen.getByText("Channels: #design")).toBeInTheDocument();
    expect(screen.queryByText("alice, bob")).not.toBeInTheDocument();
  });

  it("counts the channels instead of dropping any when one is not visible to the caller", async () => {
    await showScheduled(scheduled({ assignees: people, channelIds: [GENERAL.id, "00000000-0000-4000-8000-0000000009ff"] }));

    expect(screen.getByText("2 channels")).toBeInTheDocument();
    expect(screen.queryByText(/#general/)).not.toBeInTheDocument();
  });

  it("says nothing about channels for a people-only schedule", async () => {
    await showScheduled(scheduled({ assignees: people }));

    expect(screen.getByText("alice, bob")).toBeInTheDocument();
    // The schedule card's own line ("Channels: #x" / "N channels"); the filter panel has a Channels heading of its own.
    expect(screen.queryByText(/^Channels: |^\d+ channels?$/)).not.toBeInTheDocument();
  });
});
