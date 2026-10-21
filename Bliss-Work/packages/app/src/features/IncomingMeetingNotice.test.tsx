/**
 * The incoming popup's two shapes: a genuine meeting/channel invite (Video /
 * Voice / Leave, unchanged — picking a device IS how that invite is joined,
 * and there is no "accept/reject" concept for it) versus an ad-hoc call
 * (exactly Accept / Reject, joining with the call's OWN media type rather
 * than asking the recipient to choose one).
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import { announceIncomingMeeting, onMeetingJoinRequest } from "../lib/MeetingSession";
import { IncomingMeetingNotice } from "./IncomingMeetingNotice";

const api = vi.hoisted(() => ({ call: vi.fn(), declineCall: vi.fn() }));
const runtime = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: runtime.config }) }));

const CALL = "33333333-3333-4333-8333-333333333333";
const ORG = "66666666-6666-4666-8666-666666666666";
const ADA = "22222222-2222-4222-8222-222222222222";

const callRow = (over: Partial<CallDTO> = {}): CallDTO => ({
  id: CALL,
  orgId: ORG,
  kind: "MEETING",
  title: "Design review",
  media: "video",
  createdBy: ADA,
  status: "LIVE",
  createdAt: "2031-03-01T08:00:00.000Z",
  participants: [{ userId: ADA, orgId: ORG, role: "HOST", username: "ada", external: false }],
  activeShares: [],
  channelIds: [],
  ...over,
});

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
    runtime.config = {};
    api.call.mockReset();
    api.declineCall.mockReset();
    api.declineCall.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Video/Voice/Leave for a genuine meeting invite", async () => {
    api.call.mockResolvedValue(callRow());
    renderNotice();
    act(() => announceIncomingMeeting(CALL, "Design review"));

    expect(await screen.findByRole("button", { name: "Join with camera on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join with voice only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("shows exactly Accept/Reject for an ad-hoc call, and Accept joins with the call's own media", async () => {
    api.call.mockResolvedValue(callRow({ kind: "DIRECT", media: "audio" }));
    renderNotice();
    const joins: Array<{ callId: string; media?: string }> = [];
    const off = onMeetingJoinRequest((callId, media) => joins.push({ callId, media }));

    act(() => announceIncomingMeeting(CALL, "Conference call", { actorName: "Ada" }));

    // Exactly two actions — no device picker, no Leave wording.
    const accept = await screen.findByRole("button", { name: "Accept" });
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join with camera on" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join with voice only" })).not.toBeInTheDocument();

    await userEvent.click(accept);

    // The call was placed as voice — accepting must not upgrade it to video.
    expect(joins).toEqual([{ callId: CALL, media: "voice" }]);
    off();
  });

  it("joining through the Electron popup's own action callback clears the card (so the ring effect's cleanup fires)", async () => {
    api.call.mockResolvedValue(callRow());
    let invitePopupAction: ((callId: string, media: "video" | "voice") => void) | undefined;
    runtime.config = {
      onMeetingInviteAction: (cb: (callId: string, media: "video" | "voice") => void) => {
        invitePopupAction = cb;
        return () => {};
      },
    };
    renderNotice();
    act(() => announceIncomingMeeting(CALL, "Design review"));
    await screen.findByRole("button", { name: "Join with camera on" });

    // Simulate the native, always-on-top popup window's own Join click —
    // a separate BrowserWindow with no access to this component's dismiss().
    expect(invitePopupAction).toBeDefined();
    act(() => invitePopupAction?.(CALL, "video"));

    // The card (and the ring effect keyed on `incoming`) must clear even
    // though nothing here ever called this component's own dismiss().
    expect(screen.queryByRole("button", { name: "Join with camera on" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Reject on an ad-hoc call tells the server to decline it", async () => {
    api.call.mockResolvedValue(callRow({ kind: "DIRECT", media: "video" }));
    renderNotice();
    act(() => announceIncomingMeeting(CALL, "Conference call", {}));

    const reject = await screen.findByRole("button", { name: "Decline" });
    await userEvent.click(reject);

    expect(api.declineCall).toHaveBeenCalledWith(CALL);
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });
});
