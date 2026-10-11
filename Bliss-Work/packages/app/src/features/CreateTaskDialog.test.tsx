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
import { makeChannels, makeUsers, pagedChannels, pagedDirectory, stubScrollGeometry } from "../test/pagedPickerApi";
import { setClockTime } from "../test/timePicker";

const h = vi.hoisted(() => ({
  api: { createTask: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn(), directory: vi.fn(), channels: vi.fn() },
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
  await user.click(await screen.findByRole("checkbox", { name }));
}

/** The Assign-to panel's two tabs, named by their live counts: "People (1)". */
const tab = (name: "People" | "Channels", count?: number) =>
  screen.getByRole("tab", { name: count === undefined ? new RegExp(`^${name}`) : new RegExp(`^${name} \\(${count}\\)`) });

async function pickChannel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(tab("Channels"));
  await user.click(await screen.findByRole("checkbox", { name }));
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
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
  h.api.directory.mockReset();
  h.api.channels.mockReset();
  onClose.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});
let restoreGeometry: () => void;
beforeEach(() => {
  restoreGeometry = stubScrollGeometry();
});
afterEach(() => {
  restoreGeometry();
  vi.useRealTimers();
});

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

  // jsdom has no layout engine, so the next two pin the STRUCTURE the real-browser
  // fix relies on (see Modal's FOOTER note), not pixels. Both were verified
  // against Chrome: a sticky footer inside the scroller let the Allocation cards
  // show through beneath it, and an unpositioned sr-only radio stopped scrolling
  // with the form, so Tab-focusing a card never brought it into view.
  it("keeps Create Task and Cancel outside the scrolling body, still bound to the form", () => {
    openDialog();
    const form = document.querySelector("form")!;
    const scroller = form.closest<HTMLElement>(".overflow-y-auto")!;
    const create = screen.getByRole<HTMLButtonElement>("button", { name: "Create Task" });
    expect(scroller).not.toContainElement(create);
    expect(scroller).not.toContainElement(screen.getByRole("button", { name: "Cancel" }));
    expect(create.form).toBe(form);
  });

  it("positions every allocation card so its hidden radio scrolls with the form", () => {
    openDialog();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio.closest("label")).toHaveClass("relative");
  });
});

describe("Now", () => {
  it("sends no scheduledAt/recurrence, and the assignee picked", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);

    expect(tab("People", 1)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.title).toBe("Ship the report");
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.allocation).toBe("NOW");
    expect(body.scheduledFor).toBeUndefined();
    expect(body.recurrence).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("un-ticking a person drops that assignee", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await pickAssignee(user, /Grace Hopper/);
    expect(tab("People", 2)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Ada Lovelace/ }));
    expect(tab("People", 1)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(sent().assigneeIds).toEqual([GRACE.id]);
  });

  it("refuses to submit with no assignee picked", async () => {
    const user = openDialog();
    await title(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one assignee");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });

  it("a channel alone is counted on its tab and sent as channelIds only", async () => {
    const user = openDialog();
    await title(user);
    await pickChannel(user, /general/);

    expect(tab("Channels", 1)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.channelIds).toEqual([GENERAL.id]);
    expect(body.channelId).toBeUndefined();
    expect(body.assigneeIds).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Task sent to #general — 12 members");
  });

  it("un-ticking a channel clears the pick", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /general/ }));
    expect(tab("Channels", 0)).toBeInTheDocument();
  });
});

describe("the Assign to panel in the dialog", () => {
  it("sits in the right column, with Allocation and Deadline on the left beside Title and Description", () => {
    openDialog();
    const form = document.querySelector("form")!;
    const [left, right] = [...form.children] as HTMLElement[];
    expect(within(left!).getByPlaceholderText("What needs doing?")).toBeInTheDocument();
    expect(within(left!).getByRole("radio", { name: /Now/ })).toBeInTheDocument();
    expect(within(left!).getByLabelText("Deadline", { selector: "select" })).toBeInTheDocument();
    expect(within(right!).getByRole("group", { name: /Assign to/ })).toBeInTheDocument();
    expect(within(left!).queryByRole("group", { name: /Assign to/ })).not.toBeInTheDocument();
  });

  it("marks Assign to as required, and opens on People", () => {
    openDialog();
    expect(screen.getByRole("group", { name: /Assign to/ })).toHaveTextContent("Assign to*");
    expect(tab("People").getAttribute("aria-selected")).toBe("true");
  });

  it("has no Add people / Add channels toggles", () => {
    openDialog();
    expect(screen.queryByRole("button", { name: "Add people" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add channels" })).not.toBeInTheDocument();
  });

  it("asks for one page of a large organisation, and never for the whole directory or channel list", async () => {
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(5000)));
    h.api.channelsPage.mockReset().mockImplementation(pagedChannels(makeChannels(800)));
    const user = openDialog();
    await screen.findByRole("checkbox", { name: /Person 000/ });
    expect(screen.getAllByRole("checkbox")).toHaveLength(30);
    await user.click(tab("Channels"));
    await screen.findByRole("checkbox", { name: /team-000/ });
    expect(screen.getAllByRole("checkbox")).toHaveLength(30); // the visible tab
    expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(30 + 30); // both lists, one page each

    expect(h.api.directoryPage).toHaveBeenCalledTimes(1);
    expect(h.api.channelsPage).toHaveBeenCalledTimes(1);
    expect(h.api.directory).not.toHaveBeenCalled();
    expect(h.api.channels).not.toHaveBeenCalled();
  });

  it("keeps the list in a bounded scroll box inside the right column, so the dialog does not grow with the organisation", async () => {
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(5000)));
    openDialog();
    await screen.findByRole("checkbox", { name: /Person 000/ });
    const box = screen.getByLabelText("People to assign to");
    expect(box).toHaveClass("absolute", "inset-0", "overflow-y-auto"); // takes no height of its own
    expect(box.parentElement!.parentElement).toHaveClass("min-h-[20rem]", "flex-1", "overflow-hidden"); // a floor, and fills the column
    expect(box.closest("form")!.children[1]).toContainElement(box); // …and that column is the right one
  });
});

describe("People + Channels together", () => {
  it("keeps both counts in step as people and channels are toggled, across tabs", async () => {
    const user = openDialog();
    expect(tab("People", 0)).toBeInTheDocument();
    expect(tab("Channels", 0)).toBeInTheDocument();

    await pickAssignee(user, /Ada Lovelace/);
    await pickAssignee(user, /Grace Hopper/);
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    expect(tab("People", 2)).toBeInTheDocument();
    expect(tab("Channels", 2)).toBeInTheDocument();

    // Back on People the ticks are still there.
    await user.click(tab("People"));
    expect(screen.getByRole("checkbox", { name: /Ada Lovelace/ })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /Ada Lovelace/ }));
    expect(tab("People", 1)).toBeInTheDocument();

    await user.click(tab("Channels"));
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    expect(tab("Channels", 1)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /general/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /design/ })).not.toBeChecked();
  });

  it("searches people and channels independently, on the server", async () => {
    const user = openDialog();
    await screen.findByRole("checkbox", { name: /Ada Lovelace/ });
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "grace");
    await vi.waitFor(() => expect(h.api.directoryPage).toHaveBeenCalledWith(expect.objectContaining({ q: "grace", offset: 0 })));
    await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: /Ada Lovelace/ })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /Grace Hopper/ })).toBeInTheDocument();

    await user.click(tab("Channels"));
    await screen.findByRole("checkbox", { name: /general/ });
    expect(screen.getByRole("searchbox", { name: "Search your channels" })).toHaveValue(""); // not the people query
    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "des");
    await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: /general/ })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /design/ })).toBeInTheDocument();
  });

  it("offers the caller as an assignee, marked (You)", async () => {
    const user = openDialog();
    await pickAssignee(user, /Me Myself/);
    expect(screen.getAllByText(/\(You\)/).length).toBeGreaterThan(0);
  });

  it("a pick that a later search hides is still sent", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "grace");
    await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: /Ada Lovelace/ })).not.toBeInTheDocument());
    await pickAssignee(user, /Grace Hopper/);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(sent().assigneeIds.sort()).toEqual([ADA.id, GRACE.id].sort());
  });

  it("a person picked from a LATER page is sent too, alongside one from the first", async () => {
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(100)));
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Person 001/);
    const box = screen.getByLabelText("People to assign to");
    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    await pickAssignee(user, /Person 040/);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds).toHaveLength(2);
    expect(body.assigneeIds).toEqual(expect.arrayContaining([makeUsers(1, 1)[0]!.id, makeUsers(1, 40)[0]!.id]));
  });

  it("a channel picked from a later page and one found by search are both sent as channelIds", async () => {
    h.api.channelsPage.mockReset().mockImplementation(pagedChannels(makeChannels(75)));
    const user = openDialog();
    await title(user);
    await user.click(tab("Channels"));
    await user.click(await screen.findByRole("checkbox", { name: /team-001/ }));
    const box = screen.getByLabelText("Channels to assign to");
    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    await user.click(await screen.findByRole("checkbox", { name: /team-045/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "team-070");
    await user.click(await screen.findByRole("checkbox", { name: /team-070/ }));
    expect(tab("Channels", 3)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const ids = makeChannels(75);
    expect(sent().channelIds.sort()).toEqual([ids[1]!.id, ids[45]!.id, ids[70]!.id].sort());
  });

  it("people + channel is ONE request carrying both, with the channel left as a channel", async () => {
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    await pickAssignee(user, /Grace Hopper/);
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
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
    expect(body.assigneeIds).toBeUndefined();
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
    expect(tab("People", 1)).toBeInTheDocument();
    expect(tab("Channels", 1)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.api.createTask).toHaveBeenCalledTimes(2);
    expect(h.api.createTask.mock.calls[1]![0]).toMatchObject({ assigneeIds: [ADA.id], channelIds: [GENERAL.id] });
  });
});

describe("duplicate submission", () => {
  it("sends one request when the form is submitted twice while the first is in flight", async () => {
    let resolve!: (v: { taskId: string; scheduleId: null }) => void;
    h.api.createTask.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const user = openDialog();
    await title(user);
    await pickAssignee(user, /Ada Lovelace/);
    const form = (screen.getByRole("button", { name: "Create Task" }) as HTMLButtonElement).form!;
    // Two submits in the same tick (Enter held down / a double click): React has
    // not re-rendered with isPending yet, so only a latch can stop the second.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 0)); // mutate() invokes mutationFn on a microtask
    expect(h.api.createTask).toHaveBeenCalledTimes(1);

    resolve({ taskId: "t1", scheduleId: null });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.api.createTask).toHaveBeenCalledTimes(1);
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
