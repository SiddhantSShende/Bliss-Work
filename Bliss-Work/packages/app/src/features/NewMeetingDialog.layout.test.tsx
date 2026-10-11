/**
 * The New Meeting form's two-column layout. Left: Meeting Title, Start Time, End Time, then
 * Add (People / Channels). Right: the live Meeting Preview, then Repeat. Cancel and Start
 * Meeting are a footer pinned bottom-right below both columns. One column below `md`, in
 * the same order. There is no Description field anywhere.
 *
 * jsdom does no layout, so what is pinned here is the structure that produces it (which
 * element contains which, the order in the document, the responsive grid and the
 * fixed-height list classes) and the preview's content; the measured result — a stable
 * dialog height however long the lists are — is checked in a real browser. The behaviour
 * behind the buttons (validation, End following Start, recurrence, Add) is covered by the
 * component's other test files.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { CHANNELS, DIRECTORY, ME } from "../test/meetingFixtures";
import { addChannel, addPerson, channelsPageOf, directoryPageOf } from "../test/meetingPaging";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { NewMeetingDialog } from "./NewMeetingDialog";

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={vi.fn()} onStarted={vi.fn()} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const dialog = () => screen.getByRole("dialog", { name: "New Meeting" });
const preview = () => screen.getByRole("region", { name: "Meeting Preview" });
const grid = () => screen.getByPlaceholderText("Enter meeting title").closest("div.grid")!;
const leftColumn = () => grid().children[0] as HTMLElement;
const rightColumn = () => grid().children[1] as HTMLElement;
const addSection = () => screen.getByTestId("meeting-add-section");
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.createCallInvite.mockReset().mockResolvedValue({ id: "i", callId: "call-1", token: "t", expiresAt: "2099-01-01T00:00:00.000Z" });
  h.api.directoryPage.mockReset().mockImplementation(directoryPageOf(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(channelsPageOf(CHANNELS));
});

describe("structure", () => {
  it("puts Cancel and Start Meeting in a footer, bottom-right, and nowhere else", () => {
    openDialog();
    const footer = dialog().lastElementChild as HTMLElement;

    expect(within(footer).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Start Meeting" })).toBeInTheDocument();
    expect(footer.className).toContain("justify-end");
    // The footer is after both columns, and the preview no longer carries the buttons.
    expect(footer.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(preview()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(dialog()).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(within(dialog()).getAllByRole("button", { name: /^(Start|Schedule) Meeting$/ })).toHaveLength(1);
  });

  it("left column: title, start, end, then Add — in that order", () => {
    openDialog();
    const left = within(leftColumn());
    const pos = (el: Element) => Array.from(leftColumn().querySelectorAll("*")).indexOf(el);

    const title = left.getByPlaceholderText("Enter meeting title");
    const startDate = left.getByLabelText("Start Time date");
    const endDate = left.getByLabelText("End Time date");
    expect(pos(title)).toBeLessThan(pos(startDate));
    expect(pos(startDate)).toBeLessThan(pos(endDate));
    expect(pos(endDate)).toBeLessThan(pos(addSection()));
    // Each date sits in the same two-column row as its time picker.
    expect(startDate.closest("div.grid")).toBe(left.getByRole("button", { name: "Start Time time" }).closest("div.grid"));
    expect(endDate.closest("div.grid")).toBe(left.getByRole("button", { name: "End Time time" }).closest("div.grid"));
  });

  it("right column: the Meeting Preview, then Repeat — and Repeat is not in the left column", () => {
    openDialog();

    expect(within(rightColumn()).getByRole("region", { name: "Meeting Preview" })).toBe(preview());
    const repeat = screen.getByLabelText("Repeat");
    expect(rightColumn().contains(repeat)).toBe(true);
    expect(leftColumn().contains(repeat)).toBe(false);
    expect(preview().compareDocumentPosition(repeat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview().contains(repeat)).toBe(false);
  });

  it("has no Description field, and no Members / Channels sections outside Add", () => {
    openDialog();

    expect(screen.queryByLabelText(/description/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/description|notes/i)).not.toBeInTheDocument();
    expect(dialog().querySelector("textarea")).toBeNull();
    expect(within(dialog()).queryByText(/description/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Members|Channels/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Meeting Details")).not.toBeInTheDocument();
  });

  it("Add is always visible, is not 'optional', sits directly below End Time, and opens on People", () => {
    openDialog();
    const endRow = screen.getByLabelText("End Time date").closest("div.grid")!.parentElement!;

    expect(addSection().previousElementSibling).toBe(endRow);
    expect(addSection()).toBeVisible();
    expect(addSection()).not.toHaveTextContent(/optional/i);
    expect(within(addSection()).getByRole("tab", { name: /^People/ })).toHaveAttribute("aria-selected", "true");
  });

  it("is a responsive grid: one column by default, two from md, and it cannot be pushed wider", () => {
    openDialog();

    expect(grid().className).toContain("grid-cols-1");
    expect(grid().className).toMatch(/md:grid-cols-\[minmax\(0,\d+fr\)_minmax\(0,\d+fr\)\]/);
    // Both columns may shrink below their content instead of stretching the dialog.
    expect(leftColumn().className).toContain("min-w-0");
    expect(rightColumn().className).toContain("min-w-0");
  });

  it("keeps the list a fixed height on both tabs, so a long list cannot make the dialog taller", async () => {
    const user = openDialog();
    const people = await screen.findByRole("region", { name: "People" });
    expect(people).toHaveClass("h-72", "overflow-y-auto");
    expect(people.className).not.toMatch(/\bmax-h-|\bh-auto\b|\bmin-h-/);

    await user.click(screen.getByRole("tab", { name: /^Channels/ }));
    const channels = await screen.findByRole("region", { name: "Channels" });
    expect(channels).toHaveClass("h-72", "overflow-y-auto");
  });
});

describe("the live Meeting Preview", () => {
  it("opens with the defaults: untitled, today, one hour, no repeat, nobody, online", () => {
    openDialog();
    const p = within(preview());

    expect(p.getByText("Untitled meeting")).toBeInTheDocument();
    expect(p.getByText("Does not repeat")).toBeInTheDocument();
    expect(p.getByText("0 members")).toBeInTheDocument();
    expect(p.getByText("0 channels")).toBeInTheDocument();
    expect(p.getByText("Online meeting")).toBeInTheDocument();
    expect(p.getByText(/1 hour/)).toBeInTheDocument();
    // "10:05 AM – 11:05 AM": start, an en dash, end.
    expect(p.getByText(/\d{1,2}:\d{2}\s?[AP]M\s–\s\d{1,2}:\d{2}\s?[AP]M/)).toBeInTheDocument();
    expect(p.getByText(new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }))).toBeInTheDocument();
  });

  it("follows the title as it is typed", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Design review");

    expect(within(preview()).getByText("Design review")).toBeInTheDocument();
    expect(within(preview()).queryByText("Untitled meeting")).not.toBeInTheDocument();
  });

  it("follows the dates: an end on another day is named, and the duration grows with it", () => {
    openDialog();
    const start = (screen.getByLabelText("Start Time date") as HTMLInputElement).value;
    const next = new Date(`${start}T12:00`);
    next.setDate(next.getDate() + 1);
    const nextDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;

    fireEvent.change(screen.getByLabelText("End Time date"), { target: { value: nextDay } });

    expect(within(preview()).getByText(/\(ends /)).toBeInTheDocument();
    expect(within(preview()).getByText(/1 day 1 hour/)).toBeInTheDocument();
  });

  it("describes the repeat rule as it is chosen", async () => {
    const user = openDialog();
    await user.selectOptions(screen.getByLabelText("Repeat"), "WEEKLY");
    expect(within(preview()).getByText(/^Repeats weekly on /)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Repeat"), "DAILY");
    expect(within(preview()).getByText("Repeats daily")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Repeat"), "NONE");
    expect(within(preview()).getByText("Does not repeat")).toBeInTheDocument();
  });

  it("does not print a rule it cannot yet describe while the interval is being retyped", async () => {
    const user = openDialog();
    await user.selectOptions(screen.getByLabelText("Repeat"), "WEEKLY");
    await user.clear(screen.getByLabelText("Repeat every"));

    expect(within(preview()).getByText("Weekly")).toBeInTheDocument();
    expect(within(preview()).queryByText(/every 0/)).not.toBeInTheDocument();
  });

  it("counts people and channels as they are picked, and the primary label follows scheduling", async () => {
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);
    await addChannel(user, /general/);

    expect(within(preview()).getByText("1 member")).toBeInTheDocument();
    expect(within(preview()).getByText("1 channel")).toBeInTheDocument();
    expect(within(addSection()).getByRole("tab", { name: /^People/ })).toHaveTextContent("(1)");
    expect(within(addSection()).getByRole("tab", { name: /^Channels/ })).toHaveTextContent("(1)");
    // A repeating meeting is always scheduled: the same button, the same place, new label.
    await user.selectOptions(screen.getByLabelText("Repeat"), "DAILY");
    expect(within(dialog()).getByRole("button", { name: "Schedule Meeting" })).toBeInTheDocument();
  });

  it("keeps naming a person in the preview after a search has scrolled their row away", async () => {
    const user = openDialog();
    await addPerson(user, /Ada Lovelace/);
    await user.type(screen.getByRole("textbox", { name: "Search your organisation" }), "grace");
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "People" })).queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument(),
    );

    expect(within(preview()).getByText("1 member")).toBeInTheDocument();
  });
});

describe("what the restructure did not change", () => {
  it("still disables the primary action and relabels it while the request is in flight", async () => {
    h.api.scheduleMeeting.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    await addPerson(user, /Ada Lovelace/);
    await user.click(within(dialog()).getByRole("button", { name: "Start Meeting" }));

    const busy = await within(dialog()).findByRole("button", { name: "Starting…" });
    expect(busy).toBeDisabled();
    expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  });

  it("still blocks an empty title with its message and sends nothing", async () => {
    const user = openDialog();
    await user.click(within(dialog()).getByRole("button", { name: "Start Meeting" }));

    expect(await screen.findByText("Meeting title is required.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("still closes from the footer Cancel button", async () => {
    const onClose = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <NewMeetingDialog onClose={onClose} />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(within(dialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
