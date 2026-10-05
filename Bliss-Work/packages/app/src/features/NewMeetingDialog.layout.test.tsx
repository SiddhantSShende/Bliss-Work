/**
 * The New Meeting form's two-column layout: Meeting Details on the left; on the right the
 * live Meeting Preview with Cancel / Start Meeting INSIDE it (there is no footer), then
 * Members, then Channels. One column below `md`, in that same order.
 *
 * jsdom does no layout, so what is pinned here is the structure that produces it (which
 * element contains which, the order in the document, the responsive grid classes) and the
 * preview's content; the measured result — no scroll at desktop sizes, no horizontal
 * overflow at 390px — was checked in a real browser. The behaviour behind the buttons
 * (validation, one-hour end, recurrence, members, channels) is covered by this
 * component's other test files, which run unchanged against this layout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, GENERAL, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directory: vi.fn(), channels: vi.fn() },
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

const preview = () => screen.getByRole("region", { name: "Meeting Preview" });
const details = () => screen.getByRole("region", { name: "Meeting Details" });
const members = () => screen.getByRole("group", { name: "Members" });
const channels = () => screen.getByRole("group", { name: "Channels" });
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.createCallInvite.mockReset().mockResolvedValue({ id: "i", callId: "call-1", token: "t", expiresAt: "2099-01-01T00:00:00.000Z" });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
});

describe("structure", () => {
  it("puts Cancel and Start Meeting inside the Meeting Preview card — and nowhere else", () => {
    openDialog();

    expect(within(preview()).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(preview()).getByRole("button", { name: "Start Meeting" })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "New Meeting" });
    expect(within(dialog).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(within(dialog).getAllByRole("button", { name: /^(Start|Schedule) Meeting$/ })).toHaveLength(1);
  });

  it("has no footer: nothing follows the two-column body inside the card", () => {
    openDialog();
    const dialog = screen.getByRole("dialog", { name: "New Meeting" });
    const body = details().closest("div.grid")!;

    expect(body.parentElement!.parentElement).toBe(dialog);
    expect(dialog.lastElementChild).toBe(body.parentElement);
  });

  it("reads details, then preview + actions, then members, then channels — the one-column order", () => {
    openDialog();

    expect(before(details(), preview())).toBe(true);
    expect(before(preview(), members())).toBe(true);
    expect(before(members(), channels())).toBe(true);
  });

  it("is a responsive grid: one column by default, two from md, and it cannot be pushed wider", () => {
    openDialog();
    const grid = details().closest("div.grid")!;

    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toMatch(/md:grid-cols-\[minmax\(0,\d+fr\)_minmax\(0,\d+fr\)\]/);
    // The right column may shrink below its content instead of stretching the dialog.
    expect(preview().parentElement!.className).toContain("min-w-0");
  });

  it("keeps the details together: title, start, end and repeat, in that order", () => {
    openDialog();
    const d = details();
    const pos = (el: Element) => Array.from(d.querySelectorAll("*")).indexOf(el);

    const title = within(d).getByPlaceholderText("Enter meeting title");
    const startDate = within(d).getByLabelText("Start Time date");
    const endDate = within(d).getByLabelText("End Time date");
    const repeat = within(d).getByLabelText("Repeat");
    expect(pos(title)).toBeLessThan(pos(startDate));
    expect(pos(startDate)).toBeLessThan(pos(endDate));
    expect(pos(endDate)).toBeLessThan(pos(repeat));
    // Each date sits in the same two-column row as its time picker.
    expect(startDate.closest("div.grid")).toBe(within(d).getByRole("button", { name: "Start Time time" }).closest("div.grid"));
    expect(endDate.closest("div.grid")).toBe(within(d).getByRole("button", { name: "End Time time" }).closest("div.grid"));
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

  it("counts members and channels as they are picked, and the primary label follows scheduling", async () => {
    const user = openDialog();
    await user.click(within(members()).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(within(channels()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));

    expect(within(preview()).getByText("1 member")).toBeInTheDocument();
    expect(within(preview()).getByText("1 channel")).toBeInTheDocument();
    expect(within(members()).getByRole("list", { name: "Members" })).toHaveTextContent(ADA.displayName);
    expect(within(channels()).getByRole("list", { name: "Channels" })).toHaveTextContent(GENERAL.name);
    // A repeating meeting is always scheduled: the same button, the same place, new label.
    await user.selectOptions(screen.getByLabelText("Repeat"), "DAILY");
    expect(within(preview()).getByRole("button", { name: "Schedule Meeting" })).toBeInTheDocument();
  });
});

describe("Members and Channels panels", () => {
  it("show a count, what they are for, an add button and an empty state", () => {
    openDialog();

    expect(within(members()).getByText("(0)")).toBeInTheDocument();
    expect(within(members()).getByText("Add people to this meeting")).toBeInTheDocument();
    expect(within(members()).getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(within(members()).getByText("No members added yet.")).toBeInTheDocument();
    expect(within(members()).getByText("Invite people to your meeting")).toBeInTheDocument();

    expect(within(channels()).getByText("(0)")).toBeInTheDocument();
    expect(within(channels()).getByText("Add channels to this meeting")).toBeInTheDocument();
    expect(within(channels()).getByRole("button", { name: "Add channels" })).toBeInTheDocument();
    expect(within(channels()).getByText("No channels added yet.")).toBeInTheDocument();
    expect(within(channels()).getByText("Everyone in a channel is invited.")).toBeInTheDocument();
  });

  it("keep the existing explanation under the chips once something is selected", async () => {
    const user = openDialog();
    await user.click(within(channels()).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /general/ }));

    expect(within(channels()).getByText("(1)")).toBeInTheDocument();
    expect(within(channels()).queryByText("No channels added yet.")).not.toBeInTheDocument();
    expect(within(channels()).getByText("Everyone in a channel is invited.")).toBeInTheDocument();
  });
});

describe("what the move did not change", () => {
  it("still disables the primary action and relabels it while the request is in flight", async () => {
    h.api.scheduleMeeting.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    await user.click(within(preview()).getByRole("button", { name: "Start Meeting" }));

    const busy = await within(preview()).findByRole("button", { name: "Starting…" });
    expect(busy).toBeDisabled();
    expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  });

  it("still blocks an empty title with its message and sends nothing", async () => {
    const user = openDialog();
    await user.click(within(preview()).getByRole("button", { name: "Start Meeting" }));

    expect(await screen.findByText("Meeting title is required.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("still closes from the Cancel button inside the preview", async () => {
    const onClose = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <NewMeetingDialog onClose={onClose} />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(within(preview()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
