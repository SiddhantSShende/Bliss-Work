/**
 * "New task" modal end to end: Now -> Schedule for later -> Recurring task ->
 * time picker -> task creation. Covers the allocation cards, the grouped
 * People + Channels assignment, and the clock TimePicker, and asserts the
 * request payloads are the shapes task-svc already accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DESIGN, DIRECTORY, GENERAL, GRACE, ME } from "../test/meetingFixtures";
import { setClockTime } from "../test/timePicker";

const h = vi.hoisted(() => ({
  api: { createTask: vi.fn(), directory: vi.fn(), channels: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { CreateTaskDialog } from "./CreateTaskDialog";

const OPENED_AT = new Date(2026, 8, 15, 10, 0, 0); // a Tuesday
const onClose = vi.fn();

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreateTaskDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** The one call the dialog made, or a failure saying it made none. */
function sent() {
  expect(h.api.createTask).toHaveBeenCalledTimes(1);
  return h.api.createTask.mock.calls[0]![0] as Record<string, any>;
}

async function title(user: ReturnType<typeof userEvent.setup>, text = "Ship the report") {
  await user.type(screen.getByPlaceholderText("What needs doing?"), text);
}

async function pickAssignee(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("button", { name: "Add people" }));
  await user.click(await screen.findByRole("button", { name }));
}

const peopleGroup = () => screen.getByRole("group", { name: "People" });
const channelsGroup = () => screen.getByRole("group", { name: "Channels" });

async function pickChannel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));
  await user.click(await within(channelsGroup()).findByRole("button", { name }));
}

/** A start on Wednesday 16 Sep 2026, 09:00 — always in the future relative to
 *  OPENED_AT (Tue 15 Sep 10:00), on the 5-minute dial the clock offers. */
async function pickFutureStart(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-16" } });
  await setClockTime(user, "Start time", 9, 0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OPENED_AT);
  useSession.setState({ user: ME });
  h.api.createTask.mockReset().mockResolvedValue({ taskId: "task-1" });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  onClose.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("layout", () => {
  it("starts on the Now card, with no schedule fields showing", () => {
    openDialog();
    expect(screen.getByRole("radio", { name: /Now/ })).toBeChecked();
    expect(screen.queryByLabelText("Start date")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start time time" })).not.toBeInTheDocument();
  });

  it("shows Create Task and Cancel", () => {
    openDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeInTheDocument();
  });
});

describe("Now", () => {
  it("sends no scheduledAt/recurrence, and the assignees picked as chips", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);

    expect(within(screen.getByRole("list", { name: "People" })).getByText("Ada Lovelace")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.title).toBe("Ship the report");
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.allocation).toBe("NOW");
    expect(body.scheduledFor).toBeUndefined();
    expect(body.recurrence).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("a chip's own remove button drops that assignee", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));

    const group = peopleGroup();
    expect(within(group).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(group).getByRole("button", { name: "Remove Ada Lovelace" }));
    const list = within(group).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Grace Hopper")).toBeInTheDocument();
  });

  it("refuses to submit with no assignee picked", async () => {
    const user = openDialog();
    await title(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one assignee");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });

  it("a channel alone is shown as a chip and sent as channelIds only", async () => {
    const user = openDialog();
    await title(user);
    await pickChannel(user, /general/);

    expect(within(screen.getByRole("list", { name: "Channels" })).getByText("general")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.channelIds).toEqual([GENERAL.id]);
    expect(body.channelId).toBeUndefined();
    expect(body.assigneeIds).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Task sent to #general — 12 members");
  });

  it("a channel chip's remove button clears the pick", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);

    await user.click(within(channelsGroup()).getByRole("button", { name: "Remove general" }));
    expect(within(channelsGroup()).getByText("No channels added yet.")).toBeInTheDocument();
  });
});

describe("People + Channels together", () => {
  it("shows both groups at all times, and opening one picker never hides the other", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);

    // Both pickers are open and both groups' chips are still on screen.
    expect(within(peopleGroup()).getByRole("textbox", { name: "Search your organisation" })).toBeInTheDocument();
    expect(within(channelsGroup()).getByRole("textbox", { name: "Search your channels" })).toBeInTheDocument();
    expect(within(peopleGroup()).getByRole("list")).toHaveTextContent("Ada Lovelace");
    expect(within(channelsGroup()).getByRole("list")).toHaveTextContent("general");

    // Closing People leaves Channels exactly as it was.
    await user.click(within(peopleGroup()).getByRole("button", { name: "Done" }));
    expect(within(channelsGroup()).getByRole("textbox", { name: "Search your channels" })).toBeInTheDocument();
    expect(within(channelsGroup()).getByRole("list")).toHaveTextContent("general");
    expect(within(peopleGroup()).getByRole("list")).toHaveTextContent("Ada Lovelace");
  });

  it("keeps chips, list state and counts in step as people and channels are toggled", async () => {
    const user = openDialog();
    expect(within(peopleGroup()).getByText("(0)")).toBeInTheDocument();
    expect(within(channelsGroup()).getByText("(0)")).toBeInTheDocument();

    await pickAssignee(user, /Ada Lovelace/);
    await user.click(within(peopleGroup()).getByRole("button", { name: /Grace Hopper/ }));
    await pickChannel(user, /general/);
    await user.click(within(channelsGroup()).getByRole("button", { name: /design/ }));

    expect(within(peopleGroup()).getByText("(2)")).toBeInTheDocument();
    expect(within(channelsGroup()).getByText("(2)")).toBeInTheDocument();
    expect(within(peopleGroup()).getByRole("button", { name: /Ada Lovelace/, pressed: true })).toBeInTheDocument();

    // Un-toggle in the list -> the chip and the count follow.
    await user.click(within(peopleGroup()).getByRole("button", { name: /Ada Lovelace/, pressed: true }));
    expect(within(peopleGroup()).getByText("(1)")).toBeInTheDocument();
    expect(within(peopleGroup()).getByRole("list")).not.toHaveTextContent("Ada Lovelace");

    // Remove a chip -> the list row un-checks and the count follows.
    await user.click(within(channelsGroup()).getByRole("button", { name: "Remove design" }));
    expect(within(channelsGroup()).getByText("(1)")).toBeInTheDocument();
    expect(within(channelsGroup()).getByRole("button", { name: /design/, pressed: false })).toBeInTheDocument();
  });

  it("searches people and channels independently", async () => {
    const user = openDialog();
    await user.click(screen.getByRole("button", { name: "Add people" }));
    await user.click(within(channelsGroup()).getByRole("button", { name: "Add channels" }));

    await user.type(screen.getByRole("textbox", { name: "Search your organisation" }), "grace");
    expect(within(peopleGroup()).getByRole("button", { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(within(peopleGroup()).queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument();
    // The channel list is untouched by the people query.
    expect(within(channelsGroup()).getByRole("button", { name: /general/ })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Search your channels" }), "des");
    expect(within(channelsGroup()).queryByRole("button", { name: /general/ })).not.toBeInTheDocument();
    expect(within(channelsGroup()).getByRole("button", { name: /design/ })).toBeInTheDocument();
  });

  it("offers the caller as an assignee, marked (You)", async () => {
    const user = openDialog();
    await pickAssignee(user, /Me Myself/);
    expect(within(peopleGroup()).getAllByText(/\(You\)/).length).toBeGreaterThan(0);
  });

  it("people + channel is ONE request carrying both, with the channel left as a channel", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(within(peopleGroup()).getByRole("button", { name: /Grace Hopper/ }));
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds.sort()).toEqual([ADA.id, GRACE.id].sort());
    // Not expanded into the channel's members: the server owns that, so a later
    // joiner still reaches the task.
    expect(body.channelIds).toEqual([GENERAL.id]);
    expect(body.title).toBe("Ship the report");
    expect(body.allocation).toBe("NOW");
    expect(toast.success).toHaveBeenCalledWith("Task sent");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("several channels are still one request, listing each channel once", async () => {
    const user = openDialog();
    await title(user);
    await pickChannel(user, /general/);
    await user.click(within(channelsGroup()).getByRole("button", { name: /design/ }));
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
    expect(body.assigneeIds).toBeUndefined();
  });

  it("people + several channels is still ONE request carrying all of them", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(within(peopleGroup()).getByRole("button", { name: /Grace Hopper/ }));
    await pickChannel(user, /general/);
    await user.click(within(channelsGroup()).getByRole("button", { name: /design/ }));
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds.sort()).toEqual([ADA.id, GRACE.id].sort());
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
    expect(body.channelId).toBeUndefined();
  });

  it("a person who may also be in the picked channel is sent once, as picked — one request, no client-side merging", async () => {
    const user = openDialog();
    await title(user);
    // Everyone is in #general in real life; the client cannot and must not decide that.
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.channelIds).toEqual([GENERAL.id]);
  });

  it("a mixed selection keeps the schedule payload exactly as before", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));
    await pickFutureStart(user);
    expect(screen.getByText(/1 person, #general/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body).toMatchObject({ allocation: "SCHEDULED", assigneeIds: [ADA.id], channelIds: [GENERAL.id] });
    expect(body.scheduledFor).toContain("2026-09-16T09:00:00");
    expect(body.recurrence).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Task scheduled");
  });

  it("a mixed selection keeps the recurrence payload exactly as before", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    await pickFutureStart(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body).toMatchObject({ allocation: "RECURRING", assigneeIds: [ADA.id], channelIds: [GENERAL.id] });
    expect(body.recurrence).toMatchObject({ frequency: "DAILY", interval: 1, endCondition: "NO_END" });
    expect(body.scheduledFor).toBeUndefined();
  });

  it("a failed create keeps the dialog and the whole selection, and retrying sends one request again", async () => {
    h.api.createTask.mockRejectedValueOnce(new Error("boom"));
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not create task", expect.anything()));
    expect(onClose).not.toHaveBeenCalled();
    expect(within(peopleGroup()).getByText("(1)")).toBeInTheDocument();
    expect(within(channelsGroup()).getByText("(1)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.api.createTask).toHaveBeenCalledTimes(2);
    expect(h.api.createTask.mock.calls[1]![0]).toMatchObject({ assigneeIds: [ADA.id], channelIds: [GENERAL.id] });
  });
});

describe("Schedule for later", () => {
  it("reveals Start date + Start time and a small summary, and sends scheduledFor", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));

    expect(screen.getByLabelText("Start date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start time time" })).toBeInTheDocument();

    await pickFutureStart(user);
    expect(screen.getByText(/This task will be assigned to/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.allocation).toBe("SCHEDULED");
    expect(body.scheduledFor).toContain("2026-09-16T09:00:00");
    expect(body.recurrence).toBeUndefined();
  });

  it("refuses a past date/time", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));

    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-15" } });
    await setClockTime(user, "Start time", 9, 0); // before OPENED_AT's 10:00

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Choose a future date and time");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });
});

describe("Recurring task", () => {
  it("reveals the existing frequency/interval/end controls and sends recurrence", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    await pickFutureStart(user);

    // Existing Daily/Weekly/Monthly + interval + end-condition controls, unchanged.
    await user.click(screen.getByRole("button", { name: "Weekly" }));
    await user.click(screen.getByRole("button", { name: "Wed" }));
    const every = screen.getByRole("spinbutton");
    await user.clear(every);
    await user.type(every, "2");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.allocation).toBe("RECURRING");
    expect(body.recurrence).toMatchObject({
      frequency: "WEEKLY",
      interval: 2,
      weekdays: [0, 2], // Mon (the default) + Wed
      endCondition: "NO_END",
    });
    expect(body.recurrence.startAt).toContain("2026-09-16T09:00:00");
  });

  it("does not show the Schedule-for-later summary line", async () => {
    const user = openDialog();
    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    await pickFutureStart(user);
    expect(screen.queryByText(/This task will be assigned to/)).not.toBeInTheDocument();
  });

  it("refuses a recurring start in the past, even though Now's own untouched-start allowance does not apply here", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-15" } });
    await setClockTime(user, "Start time", 9, 0);

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Choose a future recurring start");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });
});

describe("the clock time picker", () => {
  it("Cancel leaves the previously picked time untouched", async () => {
    const user = openDialog();
    await user.click(screen.getByRole("radio", { name: /Schedule for later/ }));
    await pickFutureStart(user); // 09:00

    await user.click(screen.getByRole("button", { name: "Start time time" }));
    const popover = screen.getByRole("group", { name: "Start time time picker" });
    await user.click(within(popover).getByRole("button", { name: "3 o'clock" }));
    await user.click(within(popover).getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Start time time" })).toHaveTextContent("9:00 AM");
  });
});
