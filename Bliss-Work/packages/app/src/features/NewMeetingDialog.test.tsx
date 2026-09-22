/**
 * The Start Time defaults to the minute the popup opened at. Validation compared
 * it with the clock on every render, so a popup left open for a couple of minutes
 * refused to start a meeting with "Start time can't be in the past" for a time
 * nobody had touched. An untouched start means "now", whenever the button is
 * pressed; only a time the user picked can be in the past.
 *
 * Only the network-facing api is stubbed; the real dialog runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ api: { scheduleMeeting: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { NewMeetingDialog } from "./NewMeetingDialog";

const OPENED_AT = new Date(2026, 8, 15, 10, 0, 30);
const minutesLater = (m: number) => new Date(OPENED_AT.getTime() + m * 60_000);

const onStarted = vi.fn();
const onClose = vi.fn();

function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={onClose} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  // Only the clock is faked, so user-event and react-query keep their real timers.
  return userEvent.setup();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OPENED_AT);
  h.api.scheduleMeeting.mockReset().mockResolvedValue({ id: "call-1" });
  onStarted.mockReset();
  onClose.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("NewMeetingDialog", () => {
  it("still starts a meeting now after the popup has sat open for minutes", async () => {
    const user = openDialog();

    vi.setSystemTime(minutesLater(5));
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");
    await user.click(screen.getByRole("button", { name: "Start Now" }));

    expect(screen.queryByText("Start time can't be in the past.")).not.toBeInTheDocument();
    expect(h.api.scheduleMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Standup", scheduledAt: undefined }),
    );
  });

  it("refuses a start time the user picked in the past", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Standup");

    fireEvent.change(screen.getByLabelText("Start Time time"), { target: { value: "09:00" } });
    await user.click(screen.getByRole("button", { name: "Start Now" }));

    expect(await screen.findByText("Start time can't be in the past.")).toBeInTheDocument();
    expect(h.api.scheduleMeeting).not.toHaveBeenCalled();
  });

  it("schedules, rather than starts, a start time the user pushed into the future", async () => {
    const user = openDialog();
    await user.type(screen.getByPlaceholderText("Enter meeting title"), "Planning");

    fireEvent.change(screen.getByLabelText("Start Time time"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("End Time time"), { target: { value: "15:00" } });
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    expect(h.api.scheduleMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: new Date(2026, 8, 15, 14, 0).toISOString(), durationMinutes: 60 }),
    );
  });
});
