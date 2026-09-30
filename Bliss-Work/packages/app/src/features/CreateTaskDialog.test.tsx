/**
 * "New task" modal end to end: Now -> Schedule for later -> Recurring task ->
 * time picker -> task creation. No test existed for this dialog before —
 * this covers the redesigned allocation cards, the chip-based People/Channel
 * assignment, and the clock TimePicker, while asserting the request payload
 * shape is exactly what the (unchanged) validation/mutation code already sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, GENERAL, GRACE, ME } from "../test/meetingFixtures";
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

    expect(within(screen.getByRole("list", { name: "Assign to" })).getByText("Ada Lovelace")).toBeInTheDocument();

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

    const group = screen.getByRole("group", { name: "Assign to" });
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

  it("switching to Channel mode and picking one shows it as a chip and sends channelId", async () => {
    const user = openDialog();
    await title(user);
    await user.click(screen.getByRole("button", { name: "Channel" }));
    await user.click(screen.getByRole("button", { name: "Choose channel" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));

    expect(within(screen.getByRole("list", { name: "Assign to channel" })).getByText("general")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.channelId).toBe(GENERAL.id);
    expect(body.assigneeIds).toBeUndefined();
  });

  it("a channel chip's remove button clears the pick", async () => {
    const user = openDialog();
    await user.click(screen.getByRole("button", { name: "Channel" }));
    await user.click(screen.getByRole("button", { name: "Choose channel" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));

    const group = screen.getByRole("group", { name: "Assign to channel" });
    await user.click(within(group).getByRole("button", { name: "Remove general" }));
    expect(within(group).getByText("No channel chosen yet.")).toBeInTheDocument();
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
