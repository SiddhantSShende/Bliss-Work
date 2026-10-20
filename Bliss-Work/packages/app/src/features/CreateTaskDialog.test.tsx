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
import { ADA, CHANNELS, DESIGN, DIRECTORY, GENERAL, GRACE, LINUS, ME } from "../test/meetingFixtures";
import { makeChannels, makeUsers, pagedChannels, pagedDirectory, stubScrollGeometry } from "../test/pagedPickerApi";
import { setClockTime } from "../test/timePicker";

const h = vi.hoisted(() => ({
  api: {
    createTask: vi.fn(),
    directoryPage: vi.fn(),
    channelsPage: vi.fn(),
    projects: vi.fn(),
    directory: vi.fn(),
    channels: vi.fn(),
    channelMembers: vi.fn(),
    addChannelMembers: vi.fn(),
    createProject: vi.fn(),
  },
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

/** Smart Task Allocation: there is no manual title/project-name field any
 *  more — the server derives the title from the Projects/Channels/People
 *  selection (app/allocation.py's Rules A-H). A selection that needs a new
 *  project (more than one channel, more than one person, or a channel+person
 *  mix) must be given one through this field; a single channel or person
 *  needs nothing here at all. */
async function fillNewProjectName(user: ReturnType<typeof userEvent.setup>, text = "Website Redesign") {
  await user.type(screen.getByPlaceholderText("Name this new project"), text);
}

async function pickAssignee(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(tab("People"));
  await user.click(await screen.findByRole("checkbox", { name }));
}

/** The Assign-to panel's tabs, named by their live counts: "People (1)". */
const tab = (name: "Projects" | "People" | "Channels", count?: number) =>
  screen.getByRole("tab", { name: count === undefined ? new RegExp(`^${name}`) : new RegExp(`^${name} \\(${count}\\)`) });

async function pickChannel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(tab("Channels"));
  await user.click(await screen.findByRole("checkbox", { name }));
}

/** The <li> row for a channel by its visible name — used by the
 *  Projects-tab-channel-sync tests, which check a row's checkbox and badge
 *  rather than toggling it by accessible name alone (a project-derived row
 *  and its "ordinary picker" counterpart would otherwise be ambiguous). */
const channelRowLabel = (name: string) => screen.getByText(name, { selector: "span" }).closest("li")!;

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
  h.api.projects.mockReset().mockResolvedValue([]);
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
  h.api.directory.mockReset();
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  // Default: everyone already a member of every channel, so the membership
  // auto-add path is a no-op unless a test deliberately sets up a sparse
  // channel (see "membership auto-add" below) — every other test's
  // channel+people selections behave exactly as before.
  h.api.channelMembers.mockReset().mockResolvedValue([ME.id, ADA.id, GRACE.id, LINUS.id]);
  h.api.addChannelMembers.mockReset().mockResolvedValue(undefined);
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

  it("opens the assignment panel on Projects, Channels, People", () => {
    openDialog();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAccessibleName(/^Projects/);
    expect(tabs[1]).toHaveAccessibleName(/^Channels/);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[2]).toHaveAccessibleName(/^People/);
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
  it("sends no scheduledAt/recurrence, and the assignee picked — title derived from the one person (Rule C)", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);

    expect(tab("People", 1)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Pick channels, people, or a project/)).toHaveValue("Ada Lovelace");

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.projectId).toBeUndefined();
    expect(body.newProjectName).toBeUndefined();
    expect(body.allocation).toBe("NOW");
    expect(body.scheduledFor).toBeUndefined();
    expect(body.recurrence).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("un-ticking a person drops that assignee", async () => {
    const user = openDialog();
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
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Select at least one channel, person, or project");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });

  it("a channel alone is counted on its tab, sent as channelIds only, and derives the title (Rule A)", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);

    expect(tab("Channels", 1)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Pick channels, people, or a project/)).toHaveValue("general");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.channelIds).toEqual([GENERAL.id]);
    expect(body.channelId).toBeUndefined();
    expect(body.assigneeIds).toBeUndefined();
    expect(body.projectId).toBeUndefined();
    expect(body.newProjectName).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Task sent to #general — 12 members");
  });

  it("un-ticking a channel clears the pick", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /general/ }));
    expect(tab("Channels", 0)).toBeInTheDocument();
  });
});

describe("Smart Task Allocation title preview", () => {
  it("asks for a project name only once the selection needs one, and sends it as newProjectName", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    // One person alone: no project-name field yet.
    expect(screen.queryByPlaceholderText("Name this new project")).not.toBeInTheDocument();

    await pickChannel(user, /general/);
    // Person + channel (Rule H) now needs a project.
    expect(screen.getByPlaceholderText("Name this new project")).toBeInTheDocument();
    await fillNewProjectName(user, "Q3 Push");
    expect(screen.getByPlaceholderText(/Pick channels, people, or a project/)).toHaveValue("Q3 Push");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.newProjectName).toBe("Q3 Push");
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.channelIds).toEqual([GENERAL.id]);
  });

  it("refuses to submit a selection that needs a project name without one", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    // The now-visible field's own `required` attribute would otherwise block
    // a real click via native constraint validation before React ever sees
    // the submit — firing the form's submit event directly reaches the
    // JS-level check instead (see "duplicate submission" below).
    fireEvent.submit(document.querySelector("form")!);

    expect(toast.error).toHaveBeenCalledWith("Give this project a name");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });

  it("several channels alone also need a project name (Rule B)", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    expect(screen.getByPlaceholderText("Name this new project")).toBeInTheDocument();
    await fillNewProjectName(user, "Website Redesign");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.newProjectName).toBe("Website Redesign");
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
  });
});

describe("the Assign to panel in the dialog", () => {
  it("sits in the right column, with Allocation and Deadline on the left beside Title and Description", () => {
    openDialog();
    const form = document.querySelector("form")!;
    const [left, right] = [...form.children] as HTMLElement[];
    expect(within(left!).getByPlaceholderText(/Pick channels, people, or a project/)).toBeInTheDocument();
    expect(within(left!).getByRole("radio", { name: /Now/ })).toBeInTheDocument();
    expect(within(left!).getByLabelText("Deadline", { selector: "select" })).toBeInTheDocument();
    expect(within(right!).getByRole("group", { name: /Assign to/ })).toBeInTheDocument();
    expect(within(left!).queryByRole("group", { name: /Assign to/ })).not.toBeInTheDocument();
  });

  it("marks Assign to as required, and opens on Channels", () => {
    openDialog();
    expect(screen.getByRole("group", { name: /Assign to/ })).toHaveTextContent("Assign to*");
    expect(tab("Channels").getAttribute("aria-selected")).toBe("true");
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
    await user.click(tab("People"));
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
    const user = openDialog();
    await user.click(tab("People"));
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
    // The People badge is the EFFECTIVE recipient count: Ada + Grace (explicit)
    // union ME/Ada/Grace/Linus (the default mocked membership of #general AND
    // #design — see beforeEach) is still just those four, once both channels'
    // memberships resolve.
    await vi.waitFor(() => {
      expect(tab("People", 4)).toBeInTheDocument();
      expect(tab("Channels", 2)).toBeInTheDocument();
    });

    // Back on People the ticks are still there.
    await user.click(tab("People"));
    expect(screen.getByRole("checkbox", { name: /Ada Lovelace/ })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /Ada Lovelace/ }));
    // Ada stays checked and the count is unchanged: she is still an effective
    // recipient via the two selected channels. Unchecking her here only drops
    // her EXPLICIT pick — never silently excludes a channel member from the
    // channel-level assignment by unchecking them individually (bug-fix spec,
    // Section 15/16).
    expect(screen.getByRole("checkbox", { name: /Ada Lovelace/ })).toBeChecked();
    expect(tab("People", 4)).toBeInTheDocument();

    await user.click(tab("Channels"));
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    expect(tab("Channels", 1)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /general/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /design/ })).not.toBeChecked();
  });

  it("selecting a channel auto-checks its eligible members in the People tab, with no explicit pick", async () => {
    // #general's default mocked membership (beforeEach): ME/Ada/Grace/Linus.
    const user = openDialog();
    expect(tab("People", 0)).toBeInTheDocument();

    await pickChannel(user, /general/);
    await vi.waitFor(() => expect(tab("People", 4)).toBeInTheDocument());

    await user.click(tab("People"));
    const adaCheckbox = await screen.findByRole("checkbox", { name: /Ada Lovelace/ });
    expect(adaCheckbox).toBeChecked();
    // Shown "via" the channel, not an explicit pick — the row carries the
    // tooltip/accessible description Row gives a derived-only selection.
    expect(adaCheckbox).toHaveAccessibleDescription("From a channel");

    // Deselecting the channel drops the derived membership entirely — nobody
    // was ever explicitly picked here.
    await user.click(tab("Channels"));
    await user.click(screen.getByRole("checkbox", { name: /general/ }));
    expect(tab("People", 0)).toBeInTheDocument();
  });

  it("searches people and channels independently, on the server", async () => {
    const user = openDialog();
    await user.click(tab("People"));
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
    await user.click(tab("People"));
    await pickAssignee(user, /Ada Lovelace/);
    await user.type(screen.getByRole("searchbox", { name: "Search people in your organisation" }), "grace");
    await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: /Ada Lovelace/ })).not.toBeInTheDocument());
    await pickAssignee(user, /Grace Hopper/);
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(sent().assigneeIds.sort()).toEqual([ADA.id, GRACE.id].sort());
  });

  it("a person picked from a LATER page is sent too, alongside one from the first", async () => {
    h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(makeUsers(100)));
    const user = openDialog();
    await pickAssignee(user, /Person 001/);
    const box = screen.getByLabelText("People to assign to");
    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    await pickAssignee(user, /Person 040/);
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds).toHaveLength(2);
    expect(body.assigneeIds).toEqual(expect.arrayContaining([makeUsers(1, 1)[0]!.id, makeUsers(1, 40)[0]!.id]));
  });

  it("a channel picked from a later page and one found by search are both sent as channelIds", async () => {
    h.api.channelsPage.mockReset().mockImplementation(pagedChannels(makeChannels(75)));
    const user = openDialog();
    await user.click(tab("Channels"));
    await user.click(await screen.findByRole("checkbox", { name: /team-001/ }));
    const box = screen.getByLabelText("Channels to assign to");
    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    await user.click(await screen.findByRole("checkbox", { name: /team-045/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search your channels" }), "team-070");
    await user.click(await screen.findByRole("checkbox", { name: /team-070/ }));
    expect(tab("Channels", 3)).toBeInTheDocument();
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const ids = makeChannels(75);
    expect(sent().channelIds.sort()).toEqual([ids[1]!.id, ids[45]!.id, ids[70]!.id].sort());
  });

  it("people + channel is ONE request carrying both, with the channel left as a channel", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    await pickAssignee(user, /Grace Hopper/);
    await pickChannel(user, /general/);
    await fillNewProjectName(user, "Ship the report");
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds.sort()).toEqual([ADA.id, GRACE.id].sort());
    // Not expanded into the channel's members: the server owns that, so a later
    // joiner still reaches the task.
    expect(body.channelIds).toEqual([GENERAL.id]);
    expect(body.newProjectName).toBe("Ship the report");
    expect(body.allocation).toBe("NOW");
    expect(toast.success).toHaveBeenCalledWith("Task sent");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("several channels are still one request, listing each channel once", async () => {
    const user = openDialog();
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
    expect(body.assigneeIds).toBeUndefined();
  });

  it("a person who may also be in the picked channel is sent once, as picked — one request, no client-side merging", async () => {
    const user = openDialog();
    // Everyone is in #general in real life; the client cannot and must not decide that.
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    const body = sent();
    expect(body.assigneeIds).toEqual([ADA.id]);
    expect(body.channelIds).toEqual([GENERAL.id]);
  });

  it("a mixed selection keeps the schedule payload exactly as before", async () => {
    const user = openDialog();
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await fillNewProjectName(user);
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
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await fillNewProjectName(user);
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
    await pickAssignee(user, /Ada Lovelace/);
    await pickChannel(user, /general/);
    await fillNewProjectName(user);
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not create task", expect.anything()));
    expect(onClose).not.toHaveBeenCalled();
    // Effective count: Ada (explicit) union #general's default mocked members
    // (ME/Ada/Grace/Linus) = those four, not just Ada.
    await vi.waitFor(() => {
      expect(tab("People", 4)).toBeInTheDocument();
      expect(tab("Channels", 1)).toBeInTheDocument();
    });

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
    await pickAssignee(user, /Ada Lovelace/);
    await user.click(screen.getByRole("radio", { name: /Recurring task/ }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-15" } });
    await setClockTime(user, "Start time", 9, 0);

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Choose a future recurring start");
    expect(h.api.createTask).not.toHaveBeenCalled();
  });
});

describe("+ New project", () => {
  it("opens the standalone project-creation dialog, and selects the project it creates", async () => {
    h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
    h.api.createProject.mockReset().mockResolvedValue({
      id: "new-proj-1",
      name: "Brand New Project",
      channelId: GENERAL.id,
      channelIds: [GENERAL.id],
      status: "ACTIVE",
      canComplete: true,
    });
    const user = openDialog();
    await user.click(screen.getByRole("button", { name: "+ New" }));

    const dialog = screen.getByRole("dialog", { name: "New Project" });
    await user.type(within(dialog).getByPlaceholderText("Name this project"), "Brand New Project");
    await user.click(await within(dialog).findByRole("checkbox", { name: /general/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create Project" }));

    await vi.waitFor(() => expect(h.api.createProject).toHaveBeenCalledWith("Brand New Project", [GENERAL.id]));
    // The new project is now selected in the task form (Rule F): its name
    // previews as the title, with no project-name field needed.
    await vi.waitFor(() => expect(tab("Projects", 1)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Pick channels, people, or a project/)).toHaveValue("Brand New Project");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(sent().projectId).toBe("new-proj-1");
  });
});

describe("Projects tab channel sync", () => {
  const PROJECT = {
    id: "00000000-0000-4000-8000-000000000055",
    name: "Launch Plan",
    channelId: GENERAL.id,
    channelIds: [GENERAL.id, DESIGN.id],
    status: "ACTIVE" as const,
    canComplete: false,
  };

  it("selecting a project shows and checks its channels, and submits them as channelIds", async () => {
    h.api.projects.mockResolvedValue([PROJECT]);
    const user = openDialog();
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ }));

    await user.click(tab("Channels"));
    expect(tab("Channels", 2)).toBeInTheDocument();
    const generalRow = within(channelRowLabel("general")).getByRole("checkbox");
    const designRow = within(channelRowLabel("design")).getByRole("checkbox");
    expect(generalRow).toBeChecked();
    expect(designRow).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.projectId).toBe(PROJECT.id);
    expect(body.channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
  });

  it("deselecting one project-derived channel removes it from the submission but keeps the project", async () => {
    h.api.projects.mockResolvedValue([PROJECT]);
    const user = openDialog();
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ }));
    await user.click(tab("Channels"));
    await user.click(within(channelRowLabel("design")).getByRole("checkbox")); // deselect

    expect(tab("Channels", 1)).toBeInTheDocument();
    expect(tab("Projects", 1)).toBeInTheDocument(); // project stays selected

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    const body = sent();
    expect(body.projectId).toBe(PROJECT.id); // Rule F still wins: title is the project's
    expect(body.channelIds).toEqual([GENERAL.id]);
  });

  it("re-checking a deselected project-derived channel includes it again", async () => {
    h.api.projects.mockResolvedValue([PROJECT]);
    const user = openDialog();
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ }));
    await user.click(tab("Channels"));
    const designCheckbox = within(channelRowLabel("design")).getByRole("checkbox");
    await user.click(designCheckbox); // deselect
    await user.click(designCheckbox); // re-select
    expect(tab("Channels", 2)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(sent().channelIds.sort()).toEqual([GENERAL.id, DESIGN.id].sort());
  });

  it("deselecting the project drops its channels unless one was also picked directly", async () => {
    h.api.projects.mockResolvedValue([PROJECT]);
    const user = openDialog();
    await user.click(tab("Channels"));
    await user.click(await screen.findByRole("checkbox", { name: /general/ })); // direct pick, pre-project
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ })); // adds general (already direct) + design
    expect(tab("Channels", 2)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Launch Plan/ })); // deselect the project
    expect(tab("Projects", 0)).toBeInTheDocument();
    // #general survives (it was also picked directly); #design does not.
    expect(tab("Channels", 1)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" })); // Rule A: one channel alone needs no project name
    expect(sent().channelIds).toEqual([GENERAL.id]);
    expect(sent().projectId).toBeUndefined();
  });

  it("deselecting the project preserves people who are still included via a directly-picked channel", async () => {
    // #general and #design share the same default mocked membership
    // (ME/Ada/Grace/Linus, see the root beforeEach) — #design only arrives
    // via the project here, #general is picked directly.
    h.api.projects.mockResolvedValue([PROJECT]);
    const user = openDialog();
    await user.click(tab("Channels"));
    await user.click(await screen.findByRole("checkbox", { name: /general/ })); // direct pick, pre-project
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ })); // adds general (already direct) + design
    await vi.waitFor(() => expect(tab("People", 4)).toBeInTheDocument());

    // Deselect the project: #design drops out, #general (picked directly)
    // stays — and so does everyone #general still includes.
    await user.click(screen.getByRole("checkbox", { name: /Launch Plan/ }));
    expect(tab("Channels", 1)).toBeInTheDocument();
    expect(tab("People", 4)).toBeInTheDocument();
  });
});

describe("membership auto-add", () => {
  it("adds a missing person to the one selected channel before creating the task", async () => {
    h.api.channelMembers.mockImplementation(async (id: string) => (id === GENERAL.id ? [ME.id, GRACE.id] : [ME.id, ADA.id, GRACE.id, LINUS.id]));
    const user = openDialog();
    await pickChannel(user, /general/);
    await pickAssignee(user, /Ada Lovelace/);
    await fillNewProjectName(user); // channel + person needs one (Rule H)
    await vi.waitFor(() => expect(h.api.channelMembers).toHaveBeenCalledWith(GENERAL.id));

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
    expect(h.api.addChannelMembers).toHaveBeenCalledWith(GENERAL.id, [ADA.id]);
    expect(h.api.addChannelMembers.mock.invocationCallOrder[0]).toBeLessThan(
      h.api.createTask.mock.invocationCallOrder[0]!,
    );
  });

  it("does not call addChannelMembers when everyone picked is already a member", async () => {
    // Default beforeEach mock: ME/ADA/GRACE/LINUS are all already members.
    const user = openDialog();
    await pickChannel(user, /general/);
    await pickAssignee(user, /Ada Lovelace/);
    await fillNewProjectName(user);
    await vi.waitFor(() => expect(h.api.channelMembers).toHaveBeenCalledWith(GENERAL.id));

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
    expect(h.api.addChannelMembers).not.toHaveBeenCalled();
  });

  it("adds a person to every selected channel they are missing from, not just one", async () => {
    h.api.channelMembers.mockImplementation(async (id: string) =>
      id === GENERAL.id ? [ME.id] : id === DESIGN.id ? [ME.id, GRACE.id] : [ME.id, ADA.id, GRACE.id, LINUS.id],
    );
    const user = openDialog();
    await pickChannel(user, /general/);
    await user.click(screen.getByRole("checkbox", { name: /design/ }));
    await pickAssignee(user, /Ada Lovelace/);
    await fillNewProjectName(user); // channel + person needs one (Rule H)
    await vi.waitFor(() => expect(h.api.channelMembers).toHaveBeenCalledWith(DESIGN.id));

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
    expect(h.api.addChannelMembers).toHaveBeenCalledWith(GENERAL.id, [ADA.id]);
    expect(h.api.addChannelMembers).toHaveBeenCalledWith(DESIGN.id, [ADA.id]);
    expect(h.api.addChannelMembers).toHaveBeenCalledTimes(2);
  });

  it("a failed membership add blocks task creation and preserves the whole selection", async () => {
    h.api.channelMembers.mockResolvedValue([ME.id, GRACE.id]); // missing Ada
    h.api.addChannelMembers.mockRejectedValueOnce(new Error("forbidden"));
    const user = openDialog();
    await pickChannel(user, /general/);
    await pickAssignee(user, /Ada Lovelace/);
    await fillNewProjectName(user);
    await vi.waitFor(() => expect(h.api.channelMembers).toHaveBeenCalledWith(GENERAL.id));

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not add everyone to the selected channel(s)", expect.anything()),
    );
    expect(h.api.createTask).not.toHaveBeenCalled();
    // Effective count: Ada (explicit) union #general's mocked members here
    // (ME/Grace) = three people, not just Ada.
    expect(tab("People", 3)).toBeInTheDocument();
    expect(tab("Channels", 1)).toBeInTheDocument();

    // Retrying after the problem is fixed sends exactly one task-creation request.
    h.api.addChannelMembers.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
  });

  it("waits for channel membership to finish loading rather than guessing", async () => {
    let resolveMembers!: (ids: string[]) => void;
    h.api.channelMembers.mockReturnValueOnce(new Promise((r) => (resolveMembers = r)));
    const user = openDialog();
    await pickChannel(user, /general/);
    await pickAssignee(user, /Ada Lovelace/);
    await fillNewProjectName(user);

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(toast.error).toHaveBeenCalledWith("Still checking channel membership — try again in a moment");
    expect(h.api.createTask).not.toHaveBeenCalled();

    resolveMembers([ME.id, ADA.id]);
    await vi.waitFor(() => expect(h.api.channelMembers).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Create Task" }));
    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
    expect(h.api.addChannelMembers).not.toHaveBeenCalled(); // Ada was already a member once it loaded
  });

  it("never adds members for a channel pulled in only via a selected project", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000099",
      name: "Launch Plan",
      channelId: GENERAL.id,
      channelIds: [GENERAL.id],
      status: "ACTIVE" as const,
      canComplete: false,
    };
    h.api.projects.mockResolvedValue([project]);
    h.api.channelMembers.mockResolvedValue([ME.id]); // Ada is NOT a member of #general
    const user = openDialog();
    await user.click(tab("Projects"));
    await user.click(await screen.findByRole("checkbox", { name: /Launch Plan/ }));
    await pickAssignee(user, /Ada Lovelace/);

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    await vi.waitFor(() => expect(h.api.createTask).toHaveBeenCalledTimes(1));
    // #general was never picked directly in the Channels tab, only pulled in
    // by the project, so Ada is never silently made a member of it.
    expect(h.api.addChannelMembers).not.toHaveBeenCalled();
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
