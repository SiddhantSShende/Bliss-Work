/**
 * Regression coverage for the pin/stage derivation in CallRoom: a screen
 * share taking the stage over a genuine user pin without destroying it, the
 * stage falling back correctly once the share (or the sharer) is gone, and
 * every camera in a 4-person room staying reachable whichever layout is
 * showing.
 *
 * `useCallRoom` itself is mocked — this is about CallRoom's OWN derivation of
 * `stageId`/`pinned` from whatever participants it is handed, not about the
 * LiveKit event wiring underneath it (see useCallRoom.test.ts for that).
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Track } from "livekit-client";
import type { CallDTO } from "@taskboard/shared";
import { qk } from "../lib/queryBridge";
import type { RoomParticipant, RoomStatus } from "../lib/useCallRoom";

const h = vi.hoisted(() => ({
  useCallRoomMock: vi.fn(),
  api: {
    createCallInvite: vi.fn(async () => ({ token: "tok" })),
    saveCallChat: vi.fn(async () => {}),
    saveCallNote: vi.fn(async () => {}),
    call: vi.fn(),
  },
}));
vi.mock("../lib/useCallRoom", () => ({
  useCallRoom: h.useCallRoomMock,
  isGetUserMediaDenied: () => false,
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { CallRoom } from "./CallRoom";

// jsdom's <video>.play() exists but returns undefined rather than a Promise.
// useMeetingPiP (real, unmocked — CallRoom's own PiP mechanics, not what this
// suite is about) chains a .catch() onto it unconditionally whenever a stage
// track is present, which every test with a camera-on or sharing stage hits.
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};

// CallMembers (the un-staged grid) sizes itself from the measured area
// (lib/useElementSize), which jsdom never resizes on its own — same fix
// CallMembers.test.tsx applies, needed here too since these tests pin someone
// out of that grid before a stage exists.
let area = { width: 1200, height: 800 };
const sizedProto = HTMLElement.prototype;
const originalSize = {
  w: Object.getOwnPropertyDescriptor(sizedProto, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(sizedProto, "clientHeight"),
};
beforeEach(() => {
  Object.defineProperty(sizedProto, "clientWidth", { configurable: true, get: () => area.width });
  Object.defineProperty(sizedProto, "clientHeight", { configurable: true, get: () => area.height });
});
afterEach(() => {
  area = { width: 1200, height: 800 };
  if (originalSize.w) Object.defineProperty(sizedProto, "clientWidth", originalSize.w);
  if (originalSize.h) Object.defineProperty(sizedProto, "clientHeight", originalSize.h);
});

function fakeTrack(id: string) {
  return { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id } } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
  };
}

function person(identity: string, over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity,
    name: identity.toUpperCase(),
    isLocal: false,
    speaking: false,
    micOn: true,
    camOn: false,
    sharing: false,
    videoTrack: null,
    screenTrack: null,
    audioTrack: null,
    ...over,
  };
}

const attached = (t: Track | null) => (t as unknown as { attach: ReturnType<typeof vi.fn> }).attach;

/** What useCallRoom hands CallRoom — everything it destructures, defaulted to
 *  an ordinary connected room so each test only states what it cares about. */
function room(participants: RoomParticipant[], over: Record<string, unknown> = {}) {
  return {
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    status: "connected" as RoomStatus,
    failStage: null,
    canStart: false,
    ended: false,
    participants,
    micOn: false,
    camOn: false,
    sharing: false,
    connectedAt: Date.now(),
    toggleMic: vi.fn(async () => {}),
    toggleCam: vi.fn(async () => {}),
    toggleShare: vi.fn(async () => {}),
    addPeople: vi.fn(async () => {}),
    sendData: vi.fn(),
    onData: vi.fn(() => () => {}),
    identity: participants.find((p) => p.isLocal)?.identity ?? "local",
    connected: true,
    waiting: false,
    ...over,
  };
}

const CALL: CallDTO = {
  id: "00000000-0000-4000-8000-000000000601",
  orgId: "00000000-0000-4000-8000-000000000999",
  kind: "MEETING",
  title: "Standup",
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

/** The same meeting, before anyone opened it — exactly what MeetingSession's
 *  `enter()` freezes into its `call` state when a route asks for a meeting
 *  that has not started yet (see the doc on CallRoom's own `initialCall`). */
const SCHEDULED_CALL: CallDTO = {
  ...CALL,
  status: "SCHEDULED",
  startedAt: null,
  scheduledAt: "2026-09-29T09:00:00.000Z",
};

// api.call backs CallRoom's own live-refresh of the qk.call(id) cache entry —
// see CallRoom.tsx. Defaults to resolving the already-LIVE fixture so every
// test that does not care about this (all the pin/stage ones above) sees no
// change at all; the timer suite below overrides it per test.
beforeEach(() => {
  h.api.call.mockReset().mockResolvedValue(CALL);
});

function renderRoom(participants: RoomParticipant[], over: Record<string, unknown> = {}) {
  h.useCallRoomMock.mockReturnValue(room(participants, over));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      {/* autoJoin skips the pre-join lobby, landing straight on the connected
          room this suite is about. */}
      <CallRoom call={CALL} onClose={() => {}} autoJoin="video" />
    </QueryClientProvider>,
  );
}

/** Like renderRoom, but for the timer suite: lets a test choose the initial
 *  `call` prop (a stale SCHEDULED snapshot, typically) and hands back the
 *  QueryClient so it can drive the qk.call(id) cache the way queryBridge's
 *  real CallStarted handler does — `invalidateQueries` on it, exactly the one
 *  call already made from lib/queryBridge.tsx's handleCallEvent. */
function renderRoomWithCall(initialCall: CallDTO, participants: RoomParticipant[], over: Record<string, unknown> = {}) {
  h.useCallRoomMock.mockReturnValue(room(participants, over));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <CallRoom call={initialCall} onClose={() => {}} autoJoin="video" />
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

const pinButton = (name: string) => screen.getByRole("button", { name: new RegExp(`pin ${name}`, "i") });

/** A fresh QueryClientProvider-wrapped rerender, feeding useCallRoom a new
 *  participants list — the same "an SFU event landed" shape a real resync
 *  produces, just driven by hand. */
function rerenderRoomFn(rerender: (ui: ReactElement) => void) {
  return (participants: RoomParticipant[], over: Record<string, unknown> = {}) => {
    h.useCallRoomMock.mockReturnValue(room(participants, over));
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CallRoom call={CALL} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );
  };
}

describe("CallRoom — pin vs. screen share", () => {
  it("keeps an explicit pin through a screen share and restores it once the share ends", async () => {
    const user = userEvent.setup();
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const c = person("c", { camOn: true, videoTrack: fakeTrack("vc") });
    const { rerender } = renderRoom([a, b, c]);
    const rerenderWith = rerenderRoomFn(rerender);

    // Pin B deliberately.
    await user.click(pinButton("B"));
    expect(attached(b.videoTrack)).toHaveBeenCalled(); // B is now the stage
    attached(b.videoTrack).mockClear();

    // A starts sharing. The share takes the stage over the pin — it is not
    // destroyed, just outranked while it's live.
    const sharing = { ...a, sharing: true, screenTrack: fakeTrack("screen-a") };
    rerenderWith([sharing, b, c]);
    expect(attached(sharing.screenTrack)).toHaveBeenCalled(); // the stage is now the share
    expect(screen.getByText("Presenting")).toBeInTheDocument();
    // The generic "unpin the stage" control is for a pin somebody made — a
    // share is not that, and offering it here would do nothing anyway.
    expect(screen.queryByRole("button", { name: "Unpin the main view" })).toBeNull();

    // The share ends. B's pin was never touched, so the stage returns to B —
    // not to whoever happens to be speaking, and not to nobody.
    const stoppedSharing = { ...a, sharing: false, screenTrack: null };
    rerenderWith([stoppedSharing, b, c]);
    expect(screen.queryByText("Presenting")).toBeNull();
    expect(screen.getByRole("button", { name: "Unpin the main view" })).toBeInTheDocument();
    expect(attached(b.videoTrack)).toHaveBeenCalled(); // B is back on stage
  });

  it("does not offer to unpin a screen share, since nobody pinned it", () => {
    const a = person("a", { sharing: true, screenTrack: fakeTrack("screen-a"), camOn: true, videoTrack: fakeTrack("cam-a") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    renderRoom([a, b]);

    expect(screen.getByText("Presenting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unpin the main view" })).toBeNull();
  });

  it("falls back to whoever is left, not to a blank stage, when the sharer leaves mid-share", () => {
    const a = person("a", { sharing: true, screenTrack: fakeTrack("screen-a") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { rerender } = renderRoom([a, b]);
    const rerenderWith = rerenderRoomFn(rerender);

    // A leaves outright — dropped from the roster entirely, same as a real
    // ParticipantDisconnected resync.
    rerenderWith([b]);

    expect(screen.queryByText("Presenting")).toBeNull();
    expect(attached(b.videoTrack)).toHaveBeenCalled(); // the only person left is reachable
  });
});

describe("CallRoom — device handoff", () => {
  it("shows the switch prompt and dispatches the confirmed takeover", async () => {
    renderRoom([], { status: "switch_required" });
    const callRoom = h.useCallRoomMock.mock.results.at(-1)!.value as ReturnType<typeof room>;
    const user = userEvent.setup();

    expect(screen.getByText("You’re already in this meeting on another device")).toBeInTheDocument();
    expect(screen.getByText("You’re currently connected to this meeting from another device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch here" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Switch here" }));
    expect(callRoom.join).toHaveBeenCalledWith({ switchHere: true });
  });

  it("shows the displaced notice with Leave only", () => {
    renderRoom([], { status: "failed", failStage: "displaced" });

    expect(screen.getByText("You joined this meeting on another device")).toBeInTheDocument();
    expect(screen.getByText("This meeting is now active on another device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps Retry for a genuine disconnect", () => {
    renderRoom([], { status: "failed", failStage: "disconnected" });

    expect(screen.getByText("Disconnected from the meeting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeInTheDocument();
  });
});

describe("CallRoom — four participants stay reachable", () => {
  it("shows all four cameras once someone is pinned: the big tile plus three in the strip", async () => {
    const user = userEvent.setup();
    const room4 = [
      person("a", { camOn: true, videoTrack: fakeTrack("va") }),
      person("b", { camOn: true, videoTrack: fakeTrack("vb") }),
      person("c", { camOn: true, videoTrack: fakeTrack("vc") }),
      person("d", { camOn: true, videoTrack: fakeTrack("vd") }),
    ];
    renderRoom(room4);
    // Before the pin, this is the plain grid — pinning A is what puts a stage
    // (and therefore the filmstrip that used to eat a seat on a duplicate) on
    // screen at all.
    await user.click(pinButton("A"));

    for (const p of room4) expect(attached(p.videoTrack)).toHaveBeenCalled();
    expect(screen.queryByText(/more members/i)).toBeNull();
  });

  it("keeps the sharer's camera reachable in the strip while their screen is on stage", () => {
    const room4 = [
      person("a", { sharing: true, screenTrack: fakeTrack("screen-a"), camOn: true, videoTrack: fakeTrack("cam-a") }),
      person("b", { camOn: true, videoTrack: fakeTrack("vb") }),
      person("c", { camOn: true, videoTrack: fakeTrack("vc") }),
      person("d", { camOn: true, videoTrack: fakeTrack("vd") }),
    ];
    renderRoom(room4);

    // Not exactly once: useMeetingPiP follows the same stage track onto its
    // own hidden element regardless, which is separate, intended behaviour —
    // this is only checking the screen reaches the stage at all.
    expect(attached(room4[0]!.screenTrack)).toHaveBeenCalled(); // the big stage tile
    expect(attached(room4[0]!.videoTrack)).toHaveBeenCalledTimes(1); // and their face, in the strip
    for (const p of room4.slice(1)) expect(attached(p.videoTrack)).toHaveBeenCalledTimes(1);
  });

  it("keeps the roster and an existing pin in step as people join and leave", async () => {
    const user = userEvent.setup();
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { rerender } = renderRoom([a, b]);
    const rerenderWith = rerenderRoomFn(rerender);
    await user.click(pinButton("A"));

    const c = person("c", { camOn: true, videoTrack: fakeTrack("vc") });
    rerenderWith([a, b, c]);
    expect(attached(c.videoTrack)).toHaveBeenCalled(); // the newcomer is reachable

    // B leaves. A's pin is untouched by that — it should still be in effect.
    rerenderWith([a, c]);
    expect(screen.getByText(/2 participants/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin the main view" })).toBeInTheDocument();
  });
});

/** Any rendered "m:ss" or "h:mm:ss" clock reading — the header's meeting-
 *  duration span is the only thing in this tree shaped like it. */
const DURATION_TEXT = /^\d+:\d{2}(:\d{2})?$/;

describe("CallRoom — meeting timer reads the authoritative call, not a frozen snapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SCHEDULED → LIVE: starts showing the duration once the call this room was opened with turns live", async () => {
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { qc } = renderRoomWithCall(SCHEDULED_CALL, [b]);

    // Opened before the meeting started: no server startedAt yet, nothing to
    // count from.
    expect(screen.queryByText(DURATION_TEXT)).toBeNull();

    // The host starts it. In production this is queryBridge's CallStarted
    // handler invalidating this exact qk.call(id) entry (see handleCallEvent
    // in lib/queryBridge.tsx) and the background refetch answering with the
    // now-LIVE row; driven by hand here, but through the same cache key and
    // the same api.call the real refetch uses.
    h.api.call.mockResolvedValue(CALL);
    await qc.invalidateQueries({ queryKey: qk.call(CALL.id) });

    await waitFor(() => expect(screen.getByText(DURATION_TEXT)).toBeInTheDocument());
  });

  it("late join: shows the same elapsed time a long-time participant would, from the meeting's startedAt — never this client's own connect time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T09:05:00.000Z")); // 5 minutes after the meeting started

    const lateCall: CallDTO = { ...CALL, startedAt: "2026-09-29T09:00:00.000Z" };
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    // connectedAt is THIS client's own join moment — "now", nowhere near
    // startedAt. A timer built off it would read ~0:00 for someone who is
    // actually five minutes late.
    renderRoomWithCall(lateCall, [b], { connectedAt: Date.now() });

    expect(screen.getByText("5:00")).toBeInTheDocument();
  });

  it("reconnect/remount: keeps the correct elapsed time across a remount, even when the prop handed in is still the old SCHEDULED snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T09:10:00.000Z")); // 10 minutes after startedAt

    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { qc, unmount } = renderRoomWithCall(SCHEDULED_CALL, [b]);
    expect(screen.queryByText(DURATION_TEXT)).toBeNull();

    // The meeting is actually live by now, and the shared cache already knows
    // it — the same place the invalidate+refetch above would have left it.
    qc.setQueryData(qk.call(CALL.id), CALL);
    unmount();

    // Remounted on the SAME QueryClient (the module-level one in App.tsx is
    // never recreated) but with the SAME stale prop MeetingSession would
    // still be holding — this is the actual "reconnect/remount" case: the
    // room's own remount must not be able to regress an already-fresher cache
    // entry back to the frozen SCHEDULED snapshot it was first opened with.
    h.useCallRoomMock.mockReturnValue(room([b]));
    render(
      <QueryClientProvider client={qc}>
        <CallRoom call={SCHEDULED_CALL} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );

    expect(screen.getByText("10:00")).toBeInTheDocument();
  });
});

describe("CallRoom — Picture-in-Picture button", () => {
  // jsdom has no Picture-in-Picture; install the slice the hook touches.
  let requestPiP: ReturnType<typeof vi.fn>;
  let pipElement: Element | null;
  beforeEach(() => {
    pipElement = null;
    requestPiP = vi.fn(async function (this: HTMLVideoElement) {
      pipElement = this;
      this.dispatchEvent(new Event("enterpictureinpicture"));
    });
    HTMLVideoElement.prototype.requestPictureInPicture = requestPiP as never;
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: true });
    Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => pipElement });
    Object.defineProperty(document, "exitPictureInPicture", {
      configurable: true,
      value: vi.fn(async () => {
        const el = pipElement;
        pipElement = null;
        el?.dispatchEvent(new Event("leavepictureinpicture"));
      }),
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLMediaElement.prototype, "readyState");
    Reflect.deleteProperty(document, "pictureInPictureEnabled");
    Reflect.deleteProperty(document, "pictureInPictureElement");
    Reflect.deleteProperty(document, "exitPictureInPicture");
  });

  const pipButton = () => screen.getByRole("button", { name: /picture-in-picture/i });

  it("is not offered where the browser has no Picture-in-Picture", () => {
    Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: false });
    renderRoom([person("a", { camOn: true, videoTrack: fakeTrack("va") })]);
    expect(screen.queryByRole("button", { name: /picture-in-picture/i })).toBeNull();
  });

  it("is disabled, and says why, while nobody has a camera or screen on", async () => {
    const user = userEvent.setup();
    renderRoom([person("a"), person("b")]);
    expect(pipButton()).toBeDisabled();
    expect(pipButton()).toHaveAttribute("title", expect.stringMatching(/needs someone's video/i));
    await user.click(pipButton());
    expect(requestPiP).not.toHaveBeenCalled();
  });

  it("requests Picture-in-Picture on the element showing the live camera when clicked", async () => {
    const user = userEvent.setup();
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    renderRoom([a, person("b")]);
    expect(pipButton()).toBeEnabled();

    await user.click(pipButton());
    expect(requestPiP).toHaveBeenCalledTimes(1);
    // The element PiP was requested on is one the stage track was attached to
    // — not a stale or empty one.
    const target = requestPiP.mock.contexts[0] as HTMLVideoElement;
    expect(attached(a.videoTrack).mock.calls.some(([el]) => el === target)).toBe(true);
  });

  it("still works when the person on stage has no video but someone else does", async () => {
    const user = userEvent.setup();
    const talking = person("a", { speaking: true });
    const camera = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    renderRoom([talking, camera]);
    expect(pipButton()).toBeEnabled();

    await user.click(pipButton());
    const target = requestPiP.mock.contexts[0] as HTMLVideoElement;
    expect(attached(camera.videoTrack).mock.calls.some(([el]) => el === target)).toBe(true);
  });

  it("offers Exit while floating, and leaves Picture-in-Picture when clicked", async () => {
    const user = userEvent.setup();
    renderRoom([person("a", { camOn: true, videoTrack: fakeTrack("va") })]);
    await user.click(pipButton());

    const exit = await screen.findByRole("button", { name: /exit picture-in-picture/i });
    expect(exit).toBeEnabled();
    await user.click(exit);
    expect(document.exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /^picture-in-picture$/i })).toBeInTheDocument();
  });
});

/** An ad-hoc 1:1 — a DIRECT call with no schedule (see isAdhocCall). */
const ADHOC_CALL: CallDTO = { ...CALL, kind: "DIRECT", scheduledAt: null };
/** A scheduled DIRECT call — NOT ad-hoc, keeps the ordinary lobby rule. */
const SCHEDULED_DIRECT_CALL: CallDTO = { ...CALL, kind: "DIRECT", scheduledAt: "2026-09-29T09:00:00.000Z" };

/** Renders CallRoom with NO autoJoin prop at all — the only way to actually
 *  exercise the lobby's own initial state, since every other test in this
 *  file passes autoJoin="video" to land straight on the connected room it is
 *  testing. */
function renderWithoutAutoJoin(call: CallDTO, participants: RoomParticipant[] = []) {
  h.useCallRoomMock.mockReturnValue(room(participants));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("CallRoom — pre-join lobby, gated on call KIND not entry point", () => {
  it("skips the lobby for an ad-hoc call even with no autoJoin at all", () => {
    renderWithoutAutoJoin(ADHOC_CALL);

    expect(screen.queryByText("Ready to join?")).toBeNull();
    // Straight through to the room chrome — useCallRoom's join() was called,
    // which is exactly what the pre-join lobby exists to defer.
    const callRoom = h.useCallRoomMock.mock.results.at(-1)!.value as ReturnType<typeof room>;
    expect(callRoom.join).toHaveBeenCalled();
  });

  it("keeps the lobby for an ordinary MEETING with no autoJoin — unchanged regression", () => {
    renderWithoutAutoJoin(CALL);

    expect(screen.getByText("Ready to join?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join meeting" })).toBeInTheDocument();
    const callRoom = h.useCallRoomMock.mock.results.at(-1)!.value as ReturnType<typeof room>;
    expect(callRoom.join).not.toHaveBeenCalled();
  });

  it("keeps the lobby for a SCHEDULED (non-ad-hoc) DIRECT call too", () => {
    renderWithoutAutoJoin(SCHEDULED_DIRECT_CALL);

    expect(screen.getByText("Ready to join?")).toBeInTheDocument();
    const callRoom = h.useCallRoomMock.mock.results.at(-1)!.value as ReturnType<typeof room>;
    expect(callRoom.join).not.toHaveBeenCalled();
  });

  it("still honours autoJoin for a MEETING, exactly as before", () => {
    renderRoom([]);

    expect(screen.queryByText("Ready to join?")).toBeNull();
  });
});

describe("CallRoom — the caller waiting on a fresh ad-hoc ring", () => {
  const ADHOC_WITH_PEER: CallDTO = {
    ...ADHOC_CALL,
    participants: [
      { userId: "00000000-0000-4000-8000-000000000777", orgId: CALL.orgId, role: "PARTICIPANT", username: "jordan", joinedAt: null, leftAt: null, waitingSince: null, external: false },
    ],
  };

  it("shows a Calling… state while alone in the room, not a false success", () => {
    h.useCallRoomMock.mockReturnValue(room([person("local", { isLocal: true })], { status: "connected" }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CallRoom call={ADHOC_WITH_PEER} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/^Calling jordan…$/)).toBeInTheDocument();
  });

  it("resolves on its own once a second participant actually joins", () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CallRoom call={ADHOC_WITH_PEER} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );
    h.useCallRoomMock.mockReturnValue(room([person("local", { isLocal: true })], { status: "connected" }));
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CallRoom call={ADHOC_WITH_PEER} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Calling jordan/)).toBeInTheDocument();

    // jordan actually joins — the empty-room branch stops matching on its own.
    h.useCallRoomMock.mockReturnValue(
      room([person("local", { isLocal: true }), person("jordan")], { status: "connected" }),
    );
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CallRoom call={ADHOC_WITH_PEER} onClose={() => {}} autoJoin="video" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/Calling jordan/)).toBeNull();
  });
});
