/**
 * The New Meeting flow end to end: Create -> Schedule -> Confirmation ->
 * Copy Link. Only the network-facing api is stubbed; the real dialog, the
 * real TimePicker, and the real confirmation run.
 *
 * The Start Time defaults to the minute the popup opened at. Validation used
 * to compare it with the clock on every render, so a popup left open for a
 * couple of minutes refused to start a meeting with "Start time can't be in
 * the past" for a time nobody had touched. An untouched start means "now",
 * whenever the button is pressed; only a time the user picked can be in the
 * past.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setClockTime } from "../test/timePicker";

const h = vi.hoisted(() => ({
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directory: vi.fn(), channels: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));

import { NewMeetingDialog } from "./NewMeetingDialog";

const OPENED_AT = new Date(2026, 8, 15, 10, 0, 30);
const minutesLater = (m: number) => new Date(OPENED_AT.getTime() + m * 60_000);

const onStarted = vi.fn();
const onClose = vi.fn();
const onViewInCalendar = vi.fn();

const setClipboardApi = (writeText: ((text: string) => Promise<void>) | undefined) => {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
};

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={onClose} onStarted={onStarted} onViewInCalendar={onViewInCalendar} />
    </QueryClientProvider>,
  );
  // Only the clock is faked, so user-event and react-query keep their real timers.
  return userEvent.setup();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OPENED_AT);
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  h.api.createCallInvite
    .mockReset()
    .mockResolvedValue({ id: "invite-1", callId: "call-1", token: "tok_abc", expiresAt: "2026-09-16T10:00:00.000Z" });
  h.api.directory.mockReset().mockResolvedValue([]);
  h.api.channels.mockReset().mockResolvedValue([]);
  onStarted.mockReset();
  onClose.mockReset();
  onViewInCalendar.mockReset();
  setClipboardApi(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("NewMeetingDialog", () => {
  it("still schedules an untouched (now) start after the popup has sat open for minutes", async () => {
    const user = openDialog();

    vi.setSystemTime(minutesLater(5));
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    await user.click(screen.getByRole("button", { name: "Schedule Meeting" }));

    expect(screen.queryByText("Start time can't be in the past.")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Meeting Scheduled!" })).toBeInTheDocument();
    expect(h.api.scheduleMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Standup", scheduledAt: undefined }),
    );
  });

  it("refuses a start time the user picked in the past", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");

    await setClockTime(user, "Start Time", 9, 0);
    await user.click(screen.getByRole("button", { name: "Schedule Meeting" }));

    expect(await screen.findByText("Start time can't be in the past.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("sends scheduledAt + durationMinutes for a start time pushed into the future", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Planning");

    await setClockTime(user, "Start Time", 14, 0);
    await setClockTime(user, "End Time", 15, 0);
    await user.click(screen.getByRole("button", { name: "Schedule Meeting" }));

    expect(h.api.scheduleMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: new Date(2026, 8, 15, 14, 0).toISOString(), durationMinutes: 60 }),
    );
  });

  it("shows a live Meeting Preview that follows the title as it's typed", async () => {
    const user = openDialog();
    expect(screen.getByText("Untitled meeting")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Design review");
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.queryByText("Untitled meeting")).not.toBeInTheDocument();
  });
});

describe("the confirmation dialog", () => {
  async function schedule(user: ReturnType<typeof userEvent.setup>, title = "Standup") {
    await user.type(screen.getByPlaceholderText("Enter meeting title"), title);
    await user.click(screen.getByRole("button", { name: "Schedule Meeting" }));
    await screen.findByRole("heading", { name: "Meeting Scheduled!" });
  }

  it("replaces the form, shows the real generated join link, and mints it only once", async () => {
    const user = openDialog();
    await schedule(user);

    expect(screen.queryByPlaceholderText("Enter meeting title")).not.toBeInTheDocument();
    expect(await screen.findByText("https://app.test/join?t=tok_abc")).toBeInTheDocument();
    expect(h.api.createCallInvite).toHaveBeenCalledTimes(1);
  });

  it("Copy Link copies the real link and shows it copied", async () => {
    // Set AFTER userEvent.setup() (inside openDialog): user-event installs its
    // own clipboard stub on setup, which would otherwise clobber this one.
    const user = openDialog();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboardApi(writeText);
    await schedule(user);
    await screen.findByText("https://app.test/join?t=tok_abc");

    await user.click(screen.getByRole("button", { name: "Copy Link" }));

    expect(writeText).toHaveBeenCalledWith("https://app.test/join?t=tok_abc");
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("Start Meeting Now fires onStarted with the scheduled call and closes", async () => {
    const user = openDialog();
    await schedule(user);

    await user.click(screen.getByRole("button", { name: "Start Meeting Now" }));

    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "call-1" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("View in Calendar fires onViewInCalendar with the scheduled call and closes", async () => {
    const user = openDialog();
    await schedule(user);

    await user.click(screen.getByRole("button", { name: "View in Calendar" }));

    expect(onViewInCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: "call-1" }));
    expect(onClose).toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("Close dismisses without starting the meeting", async () => {
    const user = openDialog();
    await schedule(user);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onViewInCalendar).not.toHaveBeenCalled();
  });
});

/**
 * End used to be entirely independent of Start: opening the popup set it once
 * (buggily — see the first test below) and nothing ever touched it again, so
 * an End picked for a 9am start was still sitting there, unchanged and now
 * meaningless, after Start moved to 2pm. Start's own onDateChange/onTimeChange
 * now also reset End to Start + 1 hour — see resetEndAfterStartChange in
 * NewMeetingDialog.tsx — every time either half of Start changes, discarding
 * whatever End held, including a value the user set by hand.
 */
describe("NewMeetingDialog — End follows Start", () => {
  const dateField = (label: string) => screen.getByLabelText(`${label} date`) as HTMLInputElement;
  const timeText = (label: string) => screen.getByRole("button", { name: `${label} time` }).textContent;

  it("defaults End to Start + 1 hour", () => {
    openDialog();

    // OPENED_AT is 2026-09-15 10:00:30 -> Start reads 10:00 (seconds are not
    // part of the "HH:mm" field), so End should read 2026-09-15 11:00.
    expect(dateField("Start Time").value).toBe("2026-09-15");
    expect(timeText("Start Time")).toBe("10:00 AM");
    expect(dateField("End Time").value).toBe("2026-09-15");
    expect(timeText("End Time")).toBe("11:00 AM");
  });

  it("resets End to Start + 1 hour when Start Time changes — rolling onto the next day if that crosses midnight", async () => {
    const user = openDialog();

    await setClockTime(user, "Start Time", 23, 45);

    expect(dateField("End Time").value).toBe("2026-09-16");
    expect(timeText("End Time")).toBe("12:45 AM");
  });

  it("resets End to Start + 1 hour when Start Date changes", () => {
    openDialog();

    fireEvent.change(dateField("Start Time"), { target: { value: "2026-09-20" } });

    // Start Time itself is untouched (still 10:00); only the date should move,
    // and End should follow onto that same new date.
    expect(timeText("Start Time")).toBe("10:00 AM");
    expect(dateField("End Time").value).toBe("2026-09-20");
    expect(timeText("End Time")).toBe("11:00 AM");
  });

  it("rolls End onto the next day when the popup itself opens at 23:30", () => {
    vi.setSystemTime(new Date(2026, 8, 15, 23, 30, 0));
    openDialog();

    expect(dateField("Start Time").value).toBe("2026-09-15");
    expect(timeText("Start Time")).toBe("11:30 PM");
    expect(dateField("End Time").value).toBe("2026-09-16");
    expect(timeText("End Time")).toBe("12:30 AM");
  });

  it("discards a manually customized End the moment Start changes again", async () => {
    const user = openDialog();

    // Pick an End nowhere near Start + 1 hour.
    await setClockTime(user, "End Time", 16, 0);
    expect(timeText("End Time")).toBe("4:00 PM");

    // Start moves. The custom End is not "sticky" — it resets the same as it
    // would have from an untouched default.
    await setClockTime(user, "Start Time", 12, 0);

    expect(dateField("End Time").value).toBe("2026-09-15");
    expect(timeText("End Time")).toBe("1:00 PM");
  });

  it("submits durationMinutes computed from the auto-derived End, unmodified by hand", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Design review");

    // A future Start, End left exactly at its auto-derived value.
    await setClockTime(user, "Start Time", 14, 0);
    expect(timeText("End Time")).toBe("3:00 PM");

    await user.click(screen.getByRole("button", { name: "Schedule Meeting" }));

    expect(h.api.scheduleMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: new Date(2026, 8, 15, 14, 0).toISOString(),
        durationMinutes: 60,
      }),
    );
  });
});
