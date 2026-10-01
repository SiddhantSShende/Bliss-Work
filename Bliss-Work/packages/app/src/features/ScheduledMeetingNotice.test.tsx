/**
 * The "meeting scheduled" card.
 *
 * Driven through the same window events the app uses — announceScheduledMeeting
 * in, onMeetingJoinRequest out — rather than mocking either, so what passes here
 * is the real wiring: the bridge announces, the card renders, Join Meeting asks
 * MeetingHost (which listens on that very event) to open the call.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import { announceIncomingMeeting, onMeetingJoinRequest } from "../lib/MeetingSession";
import { announceScheduledMeeting, type ScheduledMeeting } from "../lib/scheduledMeetingNotice";
import { IncomingMeetingNotice } from "./IncomingMeetingNotice";
import { ScheduledMeetingNotice } from "./ScheduledMeetingNotice";

const api = vi.hoisted(() => ({ call: vi.fn() }));
// Mutable so a test can stand in for Electron (config.showMeetingInvitePopup).
const runtime = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: runtime.config }) }));

const CALL = "33333333-3333-4333-8333-333333333333";
const OTHER_CALL = "44444444-4444-4444-8444-444444444444";
const ORG = "66666666-6666-4666-8666-666666666666";
const ADA = "22222222-2222-4222-8222-222222222222";
const EVENT = "55555555-5555-4555-8555-555555555555";
const OTHER_EVENT = "77777777-7777-4777-8777-777777777777";

// Far from "today" in either direction, so dayLabel prints a calendar date
// rather than Today/Tomorrow and the assertions do not depend on the clock.
const START = new Date(2031, 2, 14, 9, 30).toISOString();
const END = new Date(2031, 2, 14, 10, 15).toISOString();

const callRow = (over: Partial<CallDTO> = {}): CallDTO => ({
  id: CALL,
  orgId: ORG,
  kind: "MEETING",
  title: "Design review",
  media: "video",
  createdBy: ADA,
  scheduledAt: START,
  endsAt: END,
  status: "SCHEDULED",
  createdAt: "2031-03-01T08:00:00.000Z",
  participants: [{ userId: ADA, orgId: ORG, role: "HOST", username: "ada", external: false }],
  activeShares: [],
  channelIds: [],
  ...over,
});

function renderNotice(withIncoming = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScheduledMeetingNotice />
      {withIncoming && <IncomingMeetingNotice />}
    </QueryClientProvider>,
  );
}

const announce = (over: Partial<ScheduledMeeting> = {}) =>
  act(() =>
    announceScheduledMeeting({
      eventId: EVENT,
      callId: CALL,
      title: "Design review",
      scheduledAt: START,
      ...over,
    }),
  );

const card = () => screen.queryByRole("alertdialog", { name: /Meeting scheduled/ });

beforeEach(() => {
  api.call.mockReset().mockResolvedValue(callRow());
  runtime.config = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ScheduledMeetingNotice", () => {
  it("shows nothing until a meeting is scheduled", () => {
    renderNotice();
    expect(card()).toBeNull();
  });

  it("shows the meeting title and its scheduled time", () => {
    renderNotice();
    announce();

    expect(screen.getByRole("alertdialog", { name: "Meeting scheduled: Design review" })).toBeInTheDocument();
    expect(screen.getByText("Design review")).toBeInTheDocument();
    expect(screen.getByText(/Mar.*2031/)).toBeInTheDocument();
    expect(screen.getByText(/9:30\s*AM/)).toBeInTheDocument();
  });

  it("adds the end time and the host once the call can be read", async () => {
    renderNotice();
    announce();

    expect(await screen.findByText("Hosted by ada")).toBeInTheDocument();
    expect(screen.getByText(/9:30\s*AM – 10:15\s*AM/)).toBeInTheDocument();
    expect(api.call).toHaveBeenCalledWith(CALL);
  });

  it("is still complete when the call cannot be read", async () => {
    api.call.mockRejectedValue(new Error("403"));
    renderNotice();
    announce();

    await act(async () => {});
    expect(card()).toBeInTheDocument();
    expect(screen.getByText(/9:30\s*AM/)).toBeInTheDocument();
    expect(screen.queryByText(/Hosted by/)).toBeNull();
  });

  it("falls back to a title for a meeting that has none", () => {
    renderNotice();
    announce({ title: "" });

    expect(screen.getByRole("alertdialog", { name: "Meeting scheduled: Meeting" })).toBeInTheDocument();
  });

  it("leaves the time out for a call that has none", () => {
    renderNotice();
    announce({ scheduledAt: undefined });

    expect(card()).toBeInTheDocument();
    expect(screen.queryByText(/ · /)).toBeNull();
  });

  it("Join Meeting asks the meeting host to open THIS call, then closes", async () => {
    const joins: [string, unknown][] = [];
    const off = onMeetingJoinRequest((callId, media) => joins.push([callId, media]));
    renderNotice();
    announce();

    await userEvent.setup().click(screen.getByRole("button", { name: "Join Meeting" }));

    expect(joins).toEqual([[CALL, undefined]]);
    expect(card()).toBeNull();
    off();
  });

  it("Dismiss closes it without joining", async () => {
    const joins: string[] = [];
    const off = onMeetingJoinRequest((callId) => joins.push(callId));
    renderNotice();
    announce();

    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));

    expect(card()).toBeNull();
    expect(joins).toEqual([]);
    off();
  });

  it("shows each event once — a repeat is ignored, even after a dismiss", async () => {
    renderNotice();
    announce();
    announce();
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    announce();
    expect(card()).toBeNull();
  });

  it("replaces the card when a different scheduling arrives", () => {
    renderNotice();
    announce();
    announce({ eventId: OTHER_EVENT, callId: OTHER_CALL, title: "Retro" });

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("alertdialog", { name: "Meeting scheduled: Retro" })).toBeInTheDocument();
  });

  it("goes away on its own after 20 seconds", () => {
    vi.useFakeTimers();
    renderNotice();
    announce();
    expect(card()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    expect(card()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card()).toBeNull();
  });

  it("shows the date on a tile, and a video mark instead when there is no date", () => {
    renderNotice();
    announce();
    expect(screen.getByText("Mar")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();

    announce({ eventId: OTHER_EVENT, callId: OTHER_CALL, scheduledAt: undefined });
    expect(screen.queryByText("Mar")).toBeNull();
    expect(screen.queryByText("14")).toBeNull();
  });

  describe("sharing the corner with the incoming-meeting popup", () => {
    const lifted = () => card()!.className.includes("bottom-[14rem]");

    it("moves up out of its way for as long as it stays up, then settles back", () => {
      vi.useFakeTimers();
      renderNotice();
      announce();
      expect(lifted()).toBe(false);

      act(() => announceIncomingMeeting(OTHER_CALL, "Standup"));
      expect(lifted()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(12_000);
      });
      expect(lifted()).toBe(false);
    });

    it("does not move for a meeting whose popup was already shown and gone", () => {
      vi.useFakeTimers();
      renderNotice();
      announce();
      act(() => announceIncomingMeeting(OTHER_CALL, "Standup"));
      act(() => {
        vi.advanceTimersByTime(12_000);
      });

      act(() => announceIncomingMeeting(OTHER_CALL, "Standup"));
      expect(lifted()).toBe(false);
    });

    it("stays put on Electron, where that popup is its own OS window", () => {
      runtime.config = { showMeetingInvitePopup: () => {} };
      renderNotice();
      announce();

      act(() => announceIncomingMeeting(OTHER_CALL, "Standup"));
      expect(lifted()).toBe(false);
    });
  });

  it("is independent of the incoming-meeting notice", () => {
    renderNotice(true);

    act(() => announceIncomingMeeting(OTHER_CALL, "Standup"));
    expect(screen.getByRole("alertdialog", { name: "Incoming meeting: Standup" })).toBeInTheDocument();
    expect(card()).toBeNull();

    announce();
    expect(card()).toBeInTheDocument();
    // The incoming notice neither absorbed nor lost anything.
    expect(screen.getByRole("alertdialog", { name: "Incoming meeting: Standup" })).toBeInTheDocument();
  });
});
