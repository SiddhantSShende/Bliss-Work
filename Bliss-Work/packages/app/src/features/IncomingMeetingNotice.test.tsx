/**
 * The compact incoming-meeting popup (logo, title, Video/Voice/Leave) that
 * replaced the call.started/call.waiting/call.ring sonner toast — see
 * lib/queryBridge's announceIncomingMeeting call sites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { announceIncomingMeeting } from "../lib/MeetingSession";
import { IncomingMeetingNotice } from "./IncomingMeetingNotice";

const { requestMeetingJoin } = vi.hoisted(() => ({ requestMeetingJoin: vi.fn() }));
vi.mock("../lib/MeetingSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/MeetingSession")>();
  return { ...actual, requestMeetingJoin };
});

/** announceIncomingMeeting fires a real `window` event, outside of any
 *  testing-library helper that would otherwise wrap it in `act` for us — do
 *  that here instead of at every call site. */
function announce(callId: string, title: string) {
  act(() => announceIncomingMeeting(callId, title));
}

describe("IncomingMeetingNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows nothing until a meeting is announced", () => {
    render(<IncomingMeetingNotice />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the meeting title once announced", () => {
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");
    expect(screen.getByText("Weekly review")).toBeInTheDocument();
  });

  it("never shows a blank title, even for an event with none", () => {
    render(<IncomingMeetingNotice />);
    announce("call-1", "");
    expect(screen.getByRole("alertdialog").textContent).toContain("Meeting");
  });

  it("does not stack a second card for the same meeting announced twice", () => {
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");
    announce("call-1", "Weekly review");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("replaces the card when a DIFFERENT meeting is announced", () => {
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");
    announce("call-2", "Design sync");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText("Design sync")).toBeInTheDocument();
  });

  it("Video joins with camera on and dismisses the popup", async () => {
    const user = userEvent.setup();
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /join with camera on/i }));

    expect(requestMeetingJoin).toHaveBeenCalledWith("call-1", "video");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Voice joins with camera off, mic on and dismisses the popup", async () => {
    const user = userEvent.setup();
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /join with voice only/i }));

    expect(requestMeetingJoin).toHaveBeenCalledWith("call-1", "voice");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Leave dismisses without joining the meeting", async () => {
    const user = userEvent.setup();
    render(<IncomingMeetingNotice />);
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(requestMeetingJoin).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
