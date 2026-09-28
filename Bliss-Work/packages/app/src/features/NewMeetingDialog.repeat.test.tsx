/**
 * "Repeat" on a new meeting: how often, on which days, and when it stops — and
 * what it does to the rest of the form. The real dialog runs; only the
 * network-facing api is stubbed.
 *
 * The clock is pinned to Tuesday 15 Sep 2026 so "the start date's weekday" is a
 * known day. Only Date is faked, so user-event and react-query keep real timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { CHANNELS, DIRECTORY, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), directory: vi.fn(), channels: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { NewMeetingDialog } from "./NewMeetingDialog";

const OPENED_AT = new Date(2026, 8, 15, 10, 0, 30); // a Tuesday
const onClose = vi.fn();
const onStarted = vi.fn();

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={onClose} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const sent = () => {
  expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  return h.api.scheduleMeeting.mock.calls[0]![0] as Record<string, any>;
};

/** A start in the future, on Monday 21 Sep 2026 — with the end on the same day. */
function startOnMonday() {
  fireEvent.change(screen.getByLabelText("Start Time date"), { target: { value: "2026-09-21" } });
  fireEvent.change(screen.getByLabelText("Start Time time"), { target: { value: "10:00" } });
  fireEvent.change(screen.getByLabelText("End Time date"), { target: { value: "2026-09-21" } });
  fireEvent.change(screen.getByLabelText("End Time time"), { target: { value: "11:00" } });
}

async function chooseRepeat(user: ReturnType<typeof userEvent.setup>, option: string) {
  await user.selectOptions(screen.getByLabelText("Repeat"), option);
}
const day = (name: string) => screen.getByRole("button", { name });
const pressed = () =>
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].filter(
    (n) => day(n).getAttribute("aria-pressed") === "true",
  );

async function title(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("Enter meeting title"), "Weekly review");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OPENED_AT);
  useSession.setState({ user: ME });
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  onClose.mockReset();
  onStarted.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("the Repeat control", () => {
  it("starts on 'Does not repeat' with nothing else showing", () => {
    openDialog();
    expect(screen.getByLabelText("Repeat")).toHaveValue("NONE");
    expect(screen.queryByLabelText("Repeat every")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "On" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ends")).not.toBeInTheDocument();
  });

  it("offers the four options, labelled", () => {
    openDialog();
    const options = within(screen.getByLabelText("Repeat")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Does not repeat", "Daily", "Weekly", "Monthly"]);
  });

  it("Daily and Monthly ask for the interval and the end, but not for days", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Daily");
    expect(screen.getByLabelText("Repeat every")).toHaveValue(1);
    expect(screen.getByText("day")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "On" })).not.toBeInTheDocument();
    await chooseRepeat(user, "Monthly");
    expect(screen.getByText("month")).toBeInTheDocument();
  });

  it("says what Monthly means, from the start date", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Monthly");
    expect(screen.getByText("Repeats on day 15 of the month. Months without that day are skipped.")).toBeInTheDocument();
    startOnMonday(); // 21 Sep
    expect(screen.getByText(/Repeats on day 21 of the month/)).toBeInTheDocument();
    await chooseRepeat(user, "Daily");
    expect(screen.queryByText(/of the month/)).not.toBeInTheDocument();
  });

  it("pluralises the unit with the interval", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    const every = screen.getByLabelText("Repeat every");
    await user.clear(every);
    await user.type(every, "3");
    expect(screen.getByText("weeks")).toBeInTheDocument();
  });

  it("choosing to repeat turns 'Start Now' into 'Schedule'", async () => {
    const user = openDialog();
    expect(screen.getByRole("button", { name: "Start Now" })).toBeInTheDocument();
    await chooseRepeat(user, "Weekly");
    expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
    await chooseRepeat(user, "NONE");
    expect(screen.getByRole("button", { name: "Start Now" })).toBeInTheDocument();
  });
});

describe("weekly weekdays", () => {
  // The requirement: "the selected meeting date's weekday should initially be
  // selected by default. Users can change the selection."
  it("selects the start date's weekday by default", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    expect(pressed()).toEqual(["Tuesday"]); // the clock is pinned to a Tuesday
  });

  it("follows the start date until the user picks days themselves", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    startOnMonday();
    expect(pressed()).toEqual(["Monday"]);
  });

  it("stops following once the user has chosen", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    await user.click(day("Friday"));
    expect(pressed()).toEqual(["Tuesday", "Friday"]);
    startOnMonday();
    expect(pressed()).toEqual(["Tuesday", "Friday"]);
  });

  it("supports several weekdays, each a labelled toggle", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    startOnMonday();
    await user.click(day("Wednesday"));
    await user.click(day("Friday"));
    expect(pressed()).toEqual(["Monday", "Wednesday", "Friday"]);
    await user.click(day("Wednesday"));
    expect(pressed()).toEqual(["Monday", "Friday"]);
  });

  it("names the group and every day for assistive technology", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    const group = screen.getByRole("group", { name: "On" });
    expect(within(group).getAllByRole("button")).toHaveLength(7);
    // One letter is not a name: two Ts and two Ss.
    expect(day("Tuesday")).toHaveTextContent("T");
    expect(day("Thursday")).toHaveTextContent("T");
  });

  it("is keyboard operable", async () => {
    const user = openDialog();
    await chooseRepeat(user, "Weekly");
    day("Saturday").focus();
    await user.keyboard(" ");
    expect(day("Saturday")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("what is sent", () => {
  it("does not repeat: no recurrence, and 'Start Now' still starts now", async () => {
    const user = openDialog();
    await title(user);
    await user.click(screen.getByRole("button", { name: "Start Now" }));
    const body = sent();
    expect(body.recurrence).toBeUndefined();
    expect(body.scheduledAt).toBeUndefined();
    expect(onStarted).toHaveBeenCalled();
  });

  // The request's first worked example.
  it("weekly, every week, Monday + Wednesday + Friday", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Weekly");
    startOnMonday();
    await user.click(day("Wednesday"));
    await user.click(day("Friday"));
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    const body = sent();
    expect(body.scheduledAt).toBe(new Date(2026, 8, 21, 10, 0).toISOString());
    expect(body.durationMinutes).toBe(60);
    expect(body.recurrence).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      weekdays: [0, 2, 4],
      endCondition: "NO_END",
      timeZone: expect.any(String),
    });
    expect(body.recurrence.timeZone).not.toBe("");
  });

  // The second.
  it("every 2 weeks, Tuesday + Thursday", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Weekly");
    startOnMonday();
    await user.click(day("Monday")); // off — the default
    await user.click(day("Tuesday"));
    await user.click(day("Thursday"));
    const every = screen.getByLabelText("Repeat every");
    await user.clear(every);
    await user.type(every, "2");
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(sent().recurrence).toMatchObject({ frequency: "WEEKLY", interval: 2, weekdays: [1, 3] });
  });

  it("daily and monthly carry no weekdays", async () => {
    for (const [option, frequency] of [["Daily", "DAILY"], ["Monthly", "MONTHLY"]] as const) {
      h.api.scheduleMeeting.mockClear();
      const user = openDialog();
      await title(user);
      await chooseRepeat(user, option);
      startOnMonday();
      await user.click(screen.getByRole("button", { name: "Schedule" }));
      expect(sent().recurrence.frequency).toBe(frequency);
      expect(sent().recurrence).not.toHaveProperty("weekdays");
      document.body.innerHTML = "";
    }
  });

  it("ends never / on a date / after occurrences", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();

    await user.selectOptions(screen.getByLabelText("Ends"), "On date");
    expect(screen.getByLabelText("End date")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-12-31" } });
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(sent().recurrence).toMatchObject({ endCondition: "ON_DATE", endDate: "2026-12-31" });
    expect(sent().recurrence).not.toHaveProperty("occurrenceCount");
  });

  it("after a number of occurrences", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();
    await user.selectOptions(screen.getByLabelText("Ends"), "After occurrences");
    const count = screen.getByLabelText("Number of occurrences");
    await user.clear(count);
    await user.type(count, "12");
    expect(screen.getByText("occurrences")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(sent().recurrence).toMatchObject({ endCondition: "AFTER_OCCURRENCES", occurrenceCount: 12 });
    expect(sent().recurrence).not.toHaveProperty("endDate");
  });

  it("a repeating meeting is scheduled, never started, and does not open a room", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Weekly");
    // The start time was never touched: for a one-off that means "now", but there
    // is nothing to repeat from "now", so it is still sent as a scheduled time.
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(sent().scheduledAt).toBeDefined();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("says nothing until the first attempt, then says what is wrong", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Weekly");
    startOnMonday();
    await user.click(day("Monday")); // deselect the only day
    expect(screen.queryByText("Pick at least one day.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Pick at least one day.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();

    await user.click(day("Friday"));
    expect(screen.queryByText("Pick at least one day.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  });

  it.each([["0"], ["100"], ["-2"], ["2.5"]])("refuses an interval of %s", async (value) => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();
    const every = screen.getByLabelText("Repeat every");
    fireEvent.change(every, { target: { value } });
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Enter a whole number from 1 to 99.")).toBeInTheDocument();
    expect(every).toHaveAttribute("aria-invalid", "true");
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("an empty interval is refused, not silently read as 1", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();
    await user.clear(screen.getByLabelText("Repeat every"));
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Enter a whole number from 1 to 99.")).toBeInTheDocument();
  });

  it("an end date is required, and cannot be before the first meeting", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();
    await user.selectOptions(screen.getByLabelText("Ends"), "On date");

    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Choose an end date.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-09-20" } });
    expect(await screen.findByText("The end date can't be before the first meeting.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it.each([["0"], ["1000"]])("refuses %s occurrences", async (value) => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Daily");
    startOnMonday();
    await user.selectOptions(screen.getByLabelText("Ends"), "After occurrences");
    fireEvent.change(screen.getByLabelText("Number of occurrences"), { target: { value } });
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Enter a whole number from 1 to 999.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  // A one-off's untouched start means "now, whenever you press the button". A
  // repeating meeting has no such allowance: it is held to the ordinary rule.
  it("holds a repeating meeting's start to not-in-the-past, even untouched", async () => {
    const user = openDialog();
    await title(user);
    await chooseRepeat(user, "Weekly");
    vi.setSystemTime(new Date(OPENED_AT.getTime() + 5 * 60_000)); // the popup sat open
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Start time can't be in the past.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("a one-off is still allowed its untouched start after the popup sat open", async () => {
    const user = openDialog();
    await title(user);
    vi.setSystemTime(new Date(OPENED_AT.getTime() + 5 * 60_000));
    await user.click(screen.getByRole("button", { name: "Start Now" }));
    expect(h.api.scheduleMeeting).toHaveBeenCalledTimes(1);
  });
});
