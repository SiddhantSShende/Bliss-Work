/**
 * Editing a repeating meeting: what the form restores from the server, and what it
 * sends back. The real dialog, pickers and queries run; only the api is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DESIGN, DIRECTORY, GENERAL, GRACE, ME, SERIES } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: {
    meetingSeries: vi.fn(),
    updateMeetingSeries: vi.fn(),
    directory: vi.fn(),
    channels: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { EditMeetingSeriesDialog } from "./EditMeetingSeriesDialog";

const onClose = vi.fn();
let qc: QueryClient;

function openDialog() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <EditMeetingSeriesDialog seriesId={SERIES.id} onClose={onClose} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** The form, once the series has loaded. */
async function loaded() {
  return screen.findByPlaceholderText("Enter meeting title");
}
const day = (name: string) => screen.getByRole("button", { name });
const pressed = () =>
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].filter(
    (n) => day(n).getAttribute("aria-pressed") === "true",
  );
const save = () => screen.getByRole("button", { name: "Save changes" });

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.meetingSeries.mockReset().mockResolvedValue(SERIES);
  h.api.updateMeetingSeries.mockReset().mockResolvedValue(SERIES);
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  onClose.mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("loading", () => {
  it("shows a loading state while the series is fetched", () => {
    h.api.meetingSeries.mockReturnValue(new Promise(() => {}));
    openDialog();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.getByRole("dialog", { name: "Edit repeating meeting" })).toBeInTheDocument();
  });

  it("shows an error with a retry that works", async () => {
    const user = (h.api.meetingSeries.mockRejectedValue(new Error("down")), openDialog());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this series.");
    h.api.meetingSeries.mockResolvedValue(SERIES);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await loaded()).toHaveValue("Design sync");
  });
});

// The requirement: "selected members are restored correctly when editing".
describe("restoring what was saved", () => {
  it("restores the title, the rhythm, the days and the end", async () => {
    openDialog();
    expect(await loaded()).toHaveValue("Design sync");
    expect(screen.getByLabelText("Repeat")).toHaveValue("WEEKLY");
    expect(screen.getByLabelText("Repeat every")).toHaveValue(2);
    expect(screen.getByText("weeks")).toBeInTheDocument();
    expect(pressed()).toEqual(["Tuesday", "Thursday"]);
    expect(screen.getByLabelText("Ends")).toHaveValue("AFTER_OCCURRENCES");
    expect(screen.getByLabelText("Number of occurrences")).toHaveValue(8);
  });

  it("restores the members and channels that were PICKED, as chips", async () => {
    openDialog();
    await loaded();
    const members = screen.getByRole("group", { name: "Members" });
    const channels = screen.getByRole("group", { name: "Channels" });
    await waitFor(() => expect(within(members).getByRole("list")).toHaveTextContent("Ada Lovelace"));
    await waitFor(() => expect(within(channels).getByRole("list")).toHaveTextContent("general"));
    expect(within(members).getAllByRole("listitem")).toHaveLength(1);
  });

  it("restores an end DATE", async () => {
    h.api.meetingSeries.mockResolvedValue({
      ...SERIES,
      recurrence: { ...SERIES.recurrence, endCondition: "ON_DATE", endDate: "2027-03-31", occurrenceCount: null },
    });
    openDialog();
    await loaded();
    expect(screen.getByLabelText("Ends")).toHaveValue("ON_DATE");
    expect(screen.getByLabelText("End date")).toHaveValue("2027-03-31");
  });

  it("shows the first meeting on the organiser's wall, and says it cannot be changed here", async () => {
    openDialog();
    await loaded();
    // 07:30Z is 09:30 in Berlin.
    expect(screen.getByText(/First meeting:/)).toHaveTextContent(/Oct 6, 2026.*9:30/);
    expect(screen.getByText(/can't be changed here/)).toBeInTheDocument();
  });

  it("does not offer 'Does not repeat' — that is cancelling the series", async () => {
    openDialog();
    await loaded();
    const options = within(screen.getByLabelText("Repeat")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Daily", "Weekly", "Monthly"]);
  });

  it("says what saving does: updates upcoming meetings, keeps links and guests where the time holds, leaves the past alone", async () => {
    openDialog();
    await loaded();
    const note = screen.getByText(/Saving updates the upcoming meetings/);
    expect(note).toHaveTextContent("keep their date and time keep their join links and guests");
    expect(note).toHaveTextContent("already happened are left as they are");
    // It must not claim the opposite of what the server does.
    expect(screen.queryByText(/replaces/)).not.toBeInTheDocument();
  });

  // A member deactivated, or a channel deleted, since the series was made is
  // still held by the server. Hiding it would hide a selection the organiser
  // cannot then remove.
  it("shows a selection whose member or channel has gone, and lets it be removed", async () => {
    h.api.meetingSeries.mockResolvedValue({
      ...SERIES,
      inviteeIds: [ADA.id, "00000000-0000-4000-8000-000000000777"],
      channelIds: ["00000000-0000-4000-8000-000000000888"],
    });
    const user = openDialog();
    await loaded();
    const members = screen.getByRole("group", { name: "Members" });
    expect(await within(members).findByText("Unknown member")).toBeInTheDocument();
    expect(await within(screen.getByRole("group", { name: "Channels" })).findByText("Unavailable channel")).toBeInTheDocument();

    await user.click(within(members).getByRole("button", { name: "Remove Unknown member" }));
    expect(within(members).queryByText("Unknown member")).not.toBeInTheDocument();
  });
});

describe("saving", () => {
  it("an untouched save sends back exactly what was restored", async () => {
    const user = openDialog();
    await loaded();
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Members" })).getByRole("list")).toHaveTextContent("Ada"));
    await user.click(save());
    await waitFor(() => expect(h.api.updateMeetingSeries).toHaveBeenCalledTimes(1));
    expect(h.api.updateMeetingSeries).toHaveBeenCalledWith(SERIES.id, {
      title: "Design sync",
      inviteeIds: [ADA.id],
      channelIds: [GENERAL.id],
      recurrence: {
        frequency: "WEEKLY",
        interval: 2,
        weekdays: [1, 3],
        endCondition: "AFTER_OCCURRENCES",
        occurrenceCount: 8,
        // The SERIES' zone, not the editor's own.
        timeZone: "Europe/Berlin",
      },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("sends every change: title, members, channels, weekdays, interval and end", async () => {
    const user = openDialog();
    const titleInput = await loaded();
    await user.clear(titleInput);
    await user.type(titleInput, "Design sync (new)");
    await user.click(day("Friday")); // Tue+Thu -> Tue+Thu+Fri
    const every = screen.getByLabelText("Repeat every");
    await user.clear(every);
    await user.type(every, "1");
    await user.selectOptions(screen.getByLabelText("Ends"), "Never");

    const members = screen.getByRole("group", { name: "Members" });
    await waitFor(() => expect(within(members).getByRole("list")).toHaveTextContent("Ada"));
    await user.click(within(members).getByRole("button", { name: "Remove Ada Lovelace" }));
    await user.click(within(members).getByRole("button", { name: "Add members" }));
    await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));

    const channels = screen.getByRole("group", { name: "Channels" });
    await user.click(within(channels).getByRole("button", { name: "Remove general" }));
    await user.click(within(channels).getByRole("button", { name: "Add channels" }));
    await user.click(await screen.findByRole("button", { name: /design/ }));

    await user.click(save());
    await waitFor(() => expect(h.api.updateMeetingSeries).toHaveBeenCalledTimes(1));
    expect(h.api.updateMeetingSeries).toHaveBeenCalledWith(SERIES.id, {
      title: "Design sync (new)",
      inviteeIds: [GRACE.id],
      channelIds: [DESIGN.id],
      recurrence: {
        frequency: "WEEKLY",
        interval: 1,
        weekdays: [1, 3, 4],
        endCondition: "NO_END",
        timeZone: "Europe/Berlin",
      },
    });
  });

  it("can clear every member and channel", async () => {
    const user = openDialog();
    await loaded();
    const members = screen.getByRole("group", { name: "Members" });
    const channels = screen.getByRole("group", { name: "Channels" });
    await waitFor(() => expect(within(members).getByRole("list")).toHaveTextContent("Ada"));
    await waitFor(() => expect(within(channels).getByRole("list")).toHaveTextContent("general"));
    await user.click(within(members).getByRole("button", { name: "Remove Ada Lovelace" }));
    await user.click(within(channels).getByRole("button", { name: "Remove general" }));
    await user.click(save());
    await waitFor(() => expect(h.api.updateMeetingSeries).toHaveBeenCalled());
    // Empty lists are sent, not omitted: an omitted field means "leave alone".
    expect(h.api.updateMeetingSeries.mock.calls[0]![1]).toMatchObject({ inviteeIds: [], channelIds: [] });
  });

  it("invalidates the meeting lists so every surface catches up", async () => {
    const user = openDialog();
    await loaded();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["calls"] });
  });

  it("does not save twice while the first save is in flight", async () => {
    h.api.updateMeetingSeries.mockReturnValue(new Promise(() => {}));
    const user = openDialog();
    await loaded();
    await user.click(save());
    const busy = await screen.findByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    await user.click(busy);
    await user.keyboard("{Enter}");
    expect(h.api.updateMeetingSeries).toHaveBeenCalledTimes(1);
  });
});

describe("validation", () => {
  it("needs a title", async () => {
    const user = openDialog();
    await user.clear(await loaded());
    await user.click(save());
    expect(await screen.findByText("Meeting title is required.")).toBeInTheDocument();
    expect(h.api.updateMeetingSeries).not.toHaveBeenCalled();
  });

  it("needs at least one weekday", async () => {
    const user = openDialog();
    await loaded();
    await user.click(day("Tuesday"));
    await user.click(day("Thursday"));
    await user.click(save());
    expect(await screen.findByText("Pick at least one day.")).toBeInTheDocument();
    expect(h.api.updateMeetingSeries).not.toHaveBeenCalled();
  });

  it("holds an end date to the series' first meeting date", async () => {
    const user = openDialog();
    await loaded();
    await user.selectOptions(screen.getByLabelText("Ends"), "On date");
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-05" } });
    await user.click(save());
    expect(await screen.findByText("The end date can't be before the first meeting.")).toBeInTheDocument();
    expect(h.api.updateMeetingSeries).not.toHaveBeenCalled();
  });
});

describe("when the server refuses", () => {
  it("explains a 403 — a member or channel that is gone", async () => {
    h.api.updateMeetingSeries.mockRejectedValue(new ApiError(403, "forbidden"));
    const user = openDialog();
    await loaded();
    await user.click(save());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Some of the members or channels you picked are no longer available."),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the rule's own message for a 400 (an edit that leaves nothing upcoming)", async () => {
    h.api.updateMeetingSeries.mockRejectedValue(
      new ApiError(400, "invalid recurrence: the new schedule has no upcoming meetings; cancel the series instead"),
    );
    const user = openDialog();
    await loaded();
    await user.click(save());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("cancel the series instead")),
    );
  });

  it("says it could not save for anything else, and stays open", async () => {
    h.api.updateMeetingSeries.mockRejectedValue(new ApiError(500, "internal error"));
    const user = openDialog();
    await loaded();
    await user.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save your changes"));
    expect(save()).toBeEnabled();
  });
});

it("Cancel closes without saving", async () => {
  const user = openDialog();
  await loaded();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
  expect(h.api.updateMeetingSeries).not.toHaveBeenCalled();
});
