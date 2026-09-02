/**
 * The compact incoming-meeting popup (logo, title, organizer, Video/Voice/
 * Leave) that replaced the call.started/call.waiting/call.ring sonner toast
 * — see lib/queryBridge's announceIncomingMeeting call sites.
 *
 * Also covers the Electron hand-off: on that platform this component renders
 * nothing and instead drives config.showMeetingInvitePopup (the always-on-top
 * window in main/meeting-invite-manager.ts) and listens for that window's own
 * Video/Voice click via config.onMeetingInviteAction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { announceIncomingMeeting, dismissIncomingMeeting } from "../lib/MeetingSession";
import { IncomingMeetingNotice } from "./IncomingMeetingNotice";
import type { PlatformConfig } from "../platform";

const { requestMeetingJoin } = vi.hoisted(() => ({ requestMeetingJoin: vi.fn() }));
vi.mock("../lib/MeetingSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/MeetingSession")>();
  return { ...actual, requestMeetingJoin };
});

const api = { call: vi.fn() };
let config: Partial<PlatformConfig>;
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config }) }));

/** announceIncomingMeeting/dismissIncomingMeeting fire a real `window`
 *  event, outside of any testing-library helper that would otherwise wrap it
 *  in `act` for us — do that here instead of at every call site. */
function announce(callId: string, title: string) {
  act(() => announceIncomingMeeting(callId, title));
}
function dismissViaCallEvent(callId: string) {
  act(() => dismissIncomingMeeting(callId));
}

// useQuery needs a real QueryClient in the tree, same as MeetingHost.test.tsx.
function renderNotice() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IncomingMeetingNotice />
    </QueryClientProvider>,
  );
}

describe("IncomingMeetingNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config = {};
    api.call.mockResolvedValue({ participants: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows nothing until a meeting is announced", () => {
    renderNotice();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the meeting title once announced", () => {
    renderNotice();
    announce("call-1", "Weekly review");
    expect(screen.getByText("Weekly review")).toBeInTheDocument();
  });

  it("never shows a blank title, even for an event with none", () => {
    renderNotice();
    announce("call-1", "");
    expect(screen.getByRole("alertdialog").textContent).toContain("Meeting");
  });

  it("does not stack a second card for the same meeting announced twice", () => {
    renderNotice();
    announce("call-1", "Weekly review");
    announce("call-1", "Weekly review");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("replaces the card when a DIFFERENT meeting is announced", () => {
    renderNotice();
    announce("call-1", "Weekly review");
    announce("call-2", "Design sync");
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText("Design sync")).toBeInTheDocument();
  });

  it("shows the HOST participant as the organizer once the call resolves", async () => {
    api.call.mockResolvedValue({
      participants: [
        { userId: "u1", role: "PARTICIPANT", username: "a.jones" },
        { userId: "u2", role: "HOST", username: "j.okafor" },
      ],
    });
    renderNotice();
    announce("call-1", "Weekly review");
    expect(await screen.findByText("Hosted by j.okafor")).toBeInTheDocument();
  });

  it("a dismissed invite never reappears for a later event of the SAME call", async () => {
    const user = userEvent.setup();
    renderNotice();
    announce("call-1", "Weekly review");
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // A later, different event type for the same callId (call.started, then
    // call.waiting, then call.ring can each fire once for one meeting) must
    // not bring the dismissed popup back.
    announce("call-1", "Weekly review");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("dismisses when the call ends elsewhere (organizer cancelled, or CallEnded/CallParticipantAdded)", () => {
    renderNotice();
    announce("call-1", "Weekly review");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    dismissViaCallEvent("call-1");

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does NOT dismiss for an event about a different call", () => {
    renderNotice();
    announce("call-1", "Weekly review");

    dismissViaCallEvent("call-2");

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("a call-ended dismissal is a one-time thing too — it does not resurrect a later event for that same call", () => {
    renderNotice();
    announce("call-1", "Weekly review");
    dismissViaCallEvent("call-1");
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Same "one popup, ever" rule the explicit Leave button already gets.
    announce("call-1", "Weekly review");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("auto-dismisses after 10-15 seconds with no interaction", () => {
    vi.useFakeTimers();
    renderNotice();
    act(() => announceIncomingMeeting("call-1", "Weekly review"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Video joins with camera on and dismisses the popup", async () => {
    const user = userEvent.setup();
    renderNotice();
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /join with camera on/i }));

    expect(requestMeetingJoin).toHaveBeenCalledWith("call-1", "video");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Voice joins with camera off, mic on and dismisses the popup", async () => {
    const user = userEvent.setup();
    renderNotice();
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /join with voice only/i }));

    expect(requestMeetingJoin).toHaveBeenCalledWith("call-1", "voice");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Leave dismisses without joining the meeting", async () => {
    const user = userEvent.setup();
    renderNotice();
    announce("call-1", "Weekly review");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(requestMeetingJoin).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  describe("Electron: hands off to the always-on-top popup window", () => {
    it("renders nothing itself and calls showMeetingInvitePopup instead", () => {
      config.showMeetingInvitePopup = vi.fn();
      renderNotice();
      announce("call-1", "Weekly review");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(config.showMeetingInvitePopup).toHaveBeenCalledWith("call-1", "Weekly review", "");
    });

    it("re-calls showMeetingInvitePopup once the organizer resolves, same window", async () => {
      const show = vi.fn();
      config.showMeetingInvitePopup = show;
      api.call.mockResolvedValue({
        participants: [{ userId: "u1", role: "HOST", username: "j.okafor" }],
      });
      renderNotice();
      announce("call-1", "Weekly review");
      expect(show).toHaveBeenCalledWith("call-1", "Weekly review", "");
      await waitFor(() => expect(show).toHaveBeenCalledWith("call-1", "Weekly review", "j.okafor"));
    });

    it("forwards the popup window's own Video/Voice click to requestMeetingJoin", () => {
      let action: ((callId: string, media: "video" | "voice") => void) | undefined;
      config.onMeetingInviteAction = (cb) => {
        action = cb;
        return () => {};
      };
      renderNotice();
      action?.("call-9", "voice");
      expect(requestMeetingJoin).toHaveBeenCalledWith("call-9", "voice");
    });

    it("closes the popup window too when the call ends elsewhere", () => {
      config.showMeetingInvitePopup = vi.fn();
      const dismissPopup = vi.fn();
      config.dismissMeetingInvitePopup = dismissPopup;
      renderNotice();
      announce("call-1", "Weekly review");

      dismissViaCallEvent("call-1");

      expect(dismissPopup).toHaveBeenCalledWith("call-1");
    });

    it("does not touch the popup window for an event about a different call", () => {
      config.showMeetingInvitePopup = vi.fn();
      const dismissPopup = vi.fn();
      config.dismissMeetingInvitePopup = dismissPopup;
      renderNotice();
      announce("call-1", "Weekly review");

      dismissViaCallEvent("call-2");

      expect(dismissPopup).not.toHaveBeenCalled();
    });
  });
});
