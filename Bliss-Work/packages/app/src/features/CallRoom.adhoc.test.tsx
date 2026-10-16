/**
 * The room of an ad-hoc call (a 1:1 that grew into a conference) is a CALL room:
 * called a call, with no meeting-link control, and adding people adds them to the
 * call. The same room for a meeting is unchanged.
 *
 * `useCallRoom` is mocked, as in CallRoom.test.tsx — this is about what CallRoom
 * itself shows for each kind of call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import type { RoomParticipant, RoomStatus } from "../lib/useCallRoom";
import { useSession } from "../store/session";
import { DIRECTORY, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  useCallRoomMock: vi.fn(),
  api: {
    createCallInvite: vi.fn(async () => ({ token: "tok" })),
    saveCallChat: vi.fn(async () => {}),
    saveCallNote: vi.fn(async () => {}),
    call: vi.fn(),
    directory: vi.fn(),
    endCall: vi.fn(async () => {}),
  },
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));
vi.mock("../lib/useCallRoom", () => ({ useCallRoom: h.useCallRoomMock, isGetUserMediaDenied: () => false }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
// Real sonner needs a mounted <Toaster/> to render anything to the DOM, which
// this suite does not have — an error toast is asserted on the spy, the same
// way AddPeopleDialog.test.tsx does, not by querying the screen for its text.
vi.mock("sonner", () => ({ toast: h.toast }));

import { CallRoom } from "./CallRoom";

HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });

const me: RoomParticipant = {
  identity: "local", name: "ME", isLocal: true, speaking: false, micOn: true, camOn: false,
  sharing: false, videoTrack: null, screenTrack: null, audioTrack: null,
};

function room(over: Record<string, unknown> = {}) {
  return {
    join: vi.fn(async () => {}), leave: vi.fn(async () => {}), start: vi.fn(async () => {}),
    status: "connected" as RoomStatus, failStage: null, canStart: false, ended: false,
    participants: [me], micOn: false, camOn: false, sharing: false, connectedAt: Date.now(),
    toggleMic: vi.fn(async () => {}), toggleCam: vi.fn(async () => {}), toggleShare: vi.fn(async () => {}),
    addPeople: vi.fn(async () => {}), sendData: vi.fn(), onData: vi.fn(() => () => {}),
    identity: "local", connected: true, waiting: false,
    ...over,
  };
}

const MEETING: CallDTO = {
  id: "00000000-0000-4000-8000-000000000601",
  orgId: "00000000-0000-4000-8000-000000000999",
  kind: "MEETING",
  title: "",
  media: "video",
  createdBy: "00000000-0000-4000-8000-000000000001",
  scheduledAt: null,
  endsAt: null,
  startedAt: "2026-09-29T09:00:00.000Z",
  startedBy: null,
  endedAt: null,
  status: "LIVE",
  createdAt: "2026-09-29T09:00:00.000Z",
  participants: [],
  activeShares: [],
  channelIds: [],
} as CallDTO;
const CONFERENCE: CallDTO = { ...MEETING, kind: "DIRECT" };

const participant = (userId: string, role: "HOST" | "PARTICIPANT") => ({
  userId,
  orgId: MEETING.orgId,
  role,
  username: userId,
  external: false,
});
// A genuine 3-person conference, me hosting — the shape that must offer
// "End for everyone".
const HOSTED_CONFERENCE: CallDTO = {
  ...CONFERENCE,
  participants: [participant(ME.id, "HOST"), participant("peer-1", "PARTICIPANT"), participant("peer-2", "PARTICIPANT")],
};
// Same roster size, but someone else hosts.
const GUEST_CONFERENCE: CallDTO = {
  ...CONFERENCE,
  participants: [participant("peer-1", "HOST"), participant(ME.id, "PARTICIPANT"), participant("peer-2", "PARTICIPANT")],
};
// Still just the two of us — not grown into a conference yet.
const TWO_PERSON_DIRECT: CallDTO = {
  ...CONFERENCE,
  participants: [participant(ME.id, "HOST"), participant("peer-1", "PARTICIPANT")],
};
const HOSTED_MEETING: CallDTO = {
  ...MEETING,
  participants: [participant(ME.id, "HOST"), participant("peer-1", "PARTICIPANT"), participant("peer-2", "PARTICIPANT")],
};

function renderRoom(
  call: CallDTO,
  props: { autoJoin?: "video"; onClose?: () => void } = { autoJoin: "video" },
  over = {},
) {
  h.useCallRoomMock.mockReturnValue(room(over));
  h.api.call.mockResolvedValue(call);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={() => {}} {...props} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.createCallInvite.mockClear();
  h.api.endCall.mockReset().mockResolvedValue(undefined);
  h.toast.mockClear();
  h.toast.error.mockClear();
});

describe("the room of an ad-hoc call", () => {
  it("is called a conference call, not a meeting", () => {
    renderRoom(CONFERENCE);
    expect(screen.getByText("Conference call")).toBeInTheDocument();
    expect(screen.queryByText(/^Meeting$/)).toBeNull();
  });

  it("has no meeting-link control, because a call has no link to copy", () => {
    renderRoom(CONFERENCE);
    expect(screen.queryByTitle("Copy invite link")).toBeNull();
    expect(screen.queryByText("Copy Link")).toBeNull();
  });

  it("adds people to the call itself — straight to the picker, never a link", async () => {
    const user = renderRoom(CONFERENCE);

    await user.click(screen.getByTitle("Add people"));

    expect(await screen.findByRole("dialog", { name: "Add people to this call" })).toBeInTheDocument();
    expect(screen.queryByText(/meeting link|secure link/i)).toBeNull();
    expect(h.api.createCallInvite).not.toHaveBeenCalled();
  });

  it("has no pre-join lobby at all, even with no autoJoin — an ad-hoc call never shows one", async () => {
    const callRoom = room({ status: "idle", connected: false });
    h.useCallRoomMock.mockReturnValue(callRoom);
    h.api.call.mockResolvedValue(CONFERENCE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CallRoom call={CONFERENCE} onClose={() => {}} />
      </QueryClientProvider>,
    );

    // The lobby's own copy (join button, camera-check line) never appears —
    // see CallRoom's preJoin initial-state doc: `!autoJoin && !adhoc`, so an
    // ad-hoc call is never gated on autoJoin at all, unlike a MEETING/CHANNEL/
    // scheduled-DIRECT call (covered by CallRoom.test.tsx's own pre-join suite).
    expect(screen.queryByRole("button", { name: "Join call" })).toBeNull();
    expect(screen.queryByText(/Check your camera and microphone/)).toBeNull();
    expect(callRoom.join).toHaveBeenCalled();
  });
});

describe("End for everyone — a conference-only, host-only explicit end", () => {
  it("is offered to the host once the call has genuinely grown into a conference", () => {
    renderRoom(HOSTED_CONFERENCE);
    expect(screen.getByTitle("End call for everyone")).toBeInTheDocument();
    // The ordinary leave control is still there too, unchanged.
    expect(screen.getByTitle("End call")).toBeInTheDocument();
  });

  it("is not offered while the ad-hoc call is still just the two of us", () => {
    renderRoom(TWO_PERSON_DIRECT);
    expect(screen.queryByTitle("End call for everyone")).toBeNull();
  });

  it("is not offered to someone who is not the host", () => {
    renderRoom(GUEST_CONFERENCE);
    expect(screen.queryByTitle("End call for everyone")).toBeNull();
  });

  it("is not offered on a Meeting, even a hosted one with three people", () => {
    renderRoom(HOSTED_MEETING);
    expect(screen.queryByTitle("End call for everyone")).toBeNull();
  });

  it("confirms before ending, then calls the real endCall and closes the room", async () => {
    const onClose = vi.fn();
    const user = renderRoom(HOSTED_CONFERENCE, { autoJoin: "video", onClose });

    await user.click(screen.getByTitle("End call for everyone"));
    expect(await screen.findByText("End call for everyone?")).toBeInTheDocument();
    expect(h.api.endCall).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "End for everyone" }));

    expect(h.api.endCall).toHaveBeenCalledExactlyOnceWith(HOSTED_CONFERENCE.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open and says so if the server refuses", async () => {
    h.api.endCall.mockRejectedValue(new Error("forbidden"));
    const onClose = vi.fn();
    const user = renderRoom(HOSTED_CONFERENCE, { autoJoin: "video", onClose });

    await user.click(screen.getByTitle("End call for everyone"));
    await user.click(screen.getByRole("button", { name: "End for everyone" }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Couldn't end the call for everyone", expect.anything()));
    expect(onClose).not.toHaveBeenCalled();
    // The dialog stays open — nothing silently failed and closed anyway.
    expect(screen.getByText("End call for everyone?")).toBeInTheDocument();
  });
});

describe("the room of a meeting is unchanged", () => {
  it("is a meeting, with its link control and link-sharing add flow", async () => {
    const user = renderRoom(MEETING);

    expect(screen.getByText("Meeting")).toBeInTheDocument();
    expect(screen.getByTitle("Copy invite link")).toBeInTheDocument();
    await user.click(screen.getByTitle("Add people"));
    expect(await screen.findByText("Invite teammates to join this meeting with a secure link.")).toBeInTheDocument();
  });

  it("pre-join still says meeting", async () => {
    renderRoom(MEETING, {}, { status: "idle", connected: false });
    expect(await screen.findByRole("button", { name: "Join meeting" })).toBeInTheDocument();
  });
});
