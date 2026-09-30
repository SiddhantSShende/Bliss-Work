/**
 * Regression coverage for CallTileHost: moving a participant between the
 * grid, the stage and the filmstrip must keep rendering the SAME <video>
 * element bound to the SAME track — never detach + re-attach just because
 * the LAYOUT changed. See CallTileHost.tsx's own doc for the mechanism
 * (one <CallTile> per identity, portaled to whichever slot currently claims
 * it) and the fork audit this fixes (CallRoom's stage/grid ternary,
 * CallMembers' own solo/grid ternary and CallSpeakerFilmstrip's pool are
 * three different branches of the render tree, and React cannot reuse a DOM
 * node across a branch/type change on its own).
 *
 * `useCallRoom` itself is mocked, same as CallRoom.test.tsx — this is about
 * whether CallRoom's rendered tree keeps a stable <video> identity across a
 * re-render, not about the LiveKit event wiring underneath it.
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Track } from "livekit-client";
import type { CallDTO } from "@taskboard/shared";
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

// jsdom's <video>.play() exists but returns undefined rather than a Promise
// — same shim CallRoom.test.tsx uses, needed for the same reason
// (useMeetingPiP's unconditional .catch() on it).
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};

// CallMembers sizes itself from the measured area (lib/useElementSize),
// which jsdom never resizes on its own — same fix CallMembers.test.tsx and
// CallRoom.test.tsx apply.
let area = { width: 1200, height: 800 };
const sizedProto = HTMLElement.prototype;
const originalSize = {
  w: Object.getOwnPropertyDescriptor(sizedProto, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(sizedProto, "clientHeight"),
};
beforeEach(() => {
  Object.defineProperty(sizedProto, "clientWidth", { configurable: true, get: () => area.width });
  Object.defineProperty(sizedProto, "clientHeight", { configurable: true, get: () => area.height });
  h.api.call.mockReset().mockResolvedValue(CALL);
});
afterEach(() => {
  area = { width: 1200, height: 800 };
  if (originalSize.w) Object.defineProperty(sizedProto, "clientWidth", originalSize.w);
  if (originalSize.h) Object.defineProperty(sizedProto, "clientHeight", originalSize.h);
});

function fakeTrack(id: string) {
  return { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id } } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
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

const attach = (t: Track | null) => (t as unknown as { attach: ReturnType<typeof vi.fn> }).attach;
const detach = (t: Track | null) => (t as unknown as { detach: ReturnType<typeof vi.fn> }).detach;
/** The actual <video> element a track's attach() was called with — the most
 *  direct proof available that "the same element" kept showing it. */
const attachedEl = (t: Track | null) => attach(t).mock.calls.at(-1)?.[0] as HTMLVideoElement | undefined;
/** Every element a track's attach()/detach() was ever called with. Needed
 *  once a participant is ever on stage: useMeetingPiP (real, unmocked —
 *  CallRoom's own separate, pre-existing PiP mechanism) independently
 *  attaches the SAME stage track to its own hidden element regardless, so
 *  "the last call" can land on PiP's element rather than the real tile's —
 *  checking membership rather than the last/only call tolerates that. */
const everAttachedTo = (t: Track | null) => attach(t).mock.calls.map((c) => c[0] as HTMLVideoElement);
const everDetachedFrom = (t: Track | null) => detach(t).mock.calls.map((c) => c[0] as HTMLVideoElement);

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
  id: "00000000-0000-4000-8000-000000000701",
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

function renderRoom(participants: RoomParticipant[], over: Record<string, unknown> = {}) {
  h.useCallRoomMock.mockReturnValue(room(participants, over));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CallRoom call={CALL} onClose={() => {}} autoJoin="video" />
    </QueryClientProvider>,
  );
}

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

const pinButton = (name: string) => screen.getByRole("button", { name: new RegExp(`pin ${name}`, "i") });

describe("CallRoom — stable video identity across layout transitions", () => {
  it("active speaker ↔ grid: promoting and demoting a participant never re-attaches their track", async () => {
    vi.useFakeTimers();
    try {
      const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
      const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
      const { rerender } = renderRoom([a, b]);
      const rerenderWith = rerenderRoomFn(rerender);
      expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1);
      const elInGrid = attachedEl(a.videoTrack);

      // A starts speaking. CallRoom's own active-speaker filter promotes
      // after PROMOTE_AFTER_MS (500ms) of sustained speech, checked on a
      // 250ms interval (activeSpeaker.ts) — advance past both real thresholds
      // rather than special-casing the mechanism in this test.
      const speakingA = { ...a, speaking: true };
      rerenderWith([speakingA, b]);
      await vi.advanceTimersByTimeAsync(600);

      expect(screen.getByText(/speaking/i)).toBeInTheDocument(); // now on stage
      // Once on stage, useMeetingPiP (real, unmocked, unrelated to this fix)
      // independently attaches the same track to its own hidden element, so
      // this checks the real tile's element specifically stayed attached and
      // was never detached — not that attach()/detach() were never called
      // again at all.
      expect(everAttachedTo(a.videoTrack)).toContain(elInGrid); // NOT re-mounted elsewhere
      expect(everDetachedFrom(a.videoTrack)).not.toContain(elInGrid); // the real tile itself never detached

      // A stops speaking. Demotion after DEMOTE_AFTER_MS (2000ms).
      const silentA = { ...a, speaking: false };
      rerenderWith([silentA, b]);
      await vi.advanceTimersByTimeAsync(2200);

      expect(screen.queryByText(/speaking/i)).toBeNull(); // back in the grid
      expect(everAttachedTo(a.videoTrack)).toContain(elInGrid);
      expect(everDetachedFrom(a.videoTrack)).not.toContain(elInGrid);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pin/unpin: moving to and from the stage never re-attaches the pinned participant's track", async () => {
    const user = userEvent.setup();
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const c = person("c", { camOn: true, videoTrack: fakeTrack("vc") });
    renderRoom([a, b, c]);
    expect(attach(b.videoTrack)).toHaveBeenCalledTimes(1);
    const elInGrid = attach(b.videoTrack).mock.calls[0]![0] as HTMLVideoElement;

    await user.click(pinButton("B"));
    expect(screen.getByRole("button", { name: "Unpin the main view" })).toBeInTheDocument();
    // Once on stage, useMeetingPiP (real, unmocked, unrelated to this fix)
    // independently attaches the same track to its own hidden element —
    // checking membership tolerates that; what matters is the real tile's
    // own element specifically was never detached/remounted.
    expect(everAttachedTo(b.videoTrack)).toContain(elInGrid);
    expect(everDetachedFrom(b.videoTrack)).not.toContain(elInGrid);

    await user.click(screen.getByRole("button", { name: "Unpin the main view" }));
    expect(everAttachedTo(b.videoTrack)).toContain(elInGrid);
    expect(everDetachedFrom(b.videoTrack)).not.toContain(elInGrid);
  });

  it("screen-share start/stop: the stage tile keeps the same <video> element moving from the grid to the stage, and the filmstrip's separate camera copy is a genuine, independent mount", () => {
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { rerender } = renderRoom([a, b]);
    const rerenderWith = rerenderRoomFn(rerender);
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1);
    const elInGrid = attachedEl(a.videoTrack); // the <video> element A's camera lives in, in the grid

    // A starts sharing: A's existing tile moves onto the stage — still the
    // SAME tile/key, now legitimately showing the SCREEN track instead of the
    // camera (a real source change, not a remount) — and separately gets a
    // second, independent seat in the filmstrip (CallSpeakerFilmstrip's
    // `source="camera"`) showing their camera, which did not exist before now.
    const sharing = { ...a, sharing: true, screenTrack: fakeTrack("screen-a") };
    rerenderWith([sharing, b]);
    expect(screen.getByText("Presenting")).toBeInTheDocument();
    // Not exactly once: useMeetingPiP independently attaches the same stage
    // track to its own hidden element regardless (separate, pre-existing
    // behavior — see CallRoom.test.tsx's identical note).
    expect(attach(sharing.screenTrack)).toHaveBeenCalled();
    // The proof that matters: the SCREEN now landed on the exact same <video>
    // element the CAMERA used to occupy in the grid — the stage tile itself
    // never remounted, only what is attached to it changed.
    expect(attachedEl(sharing.screenTrack)).toBe(elInGrid);
    // The camera legitimately gets detached from THAT tile once (it swapped
    // to the screen) — not a remount signature, the expected side effect of
    // the source change, already true of CallTile before this fix.
    expect(detach(a.videoTrack)).toHaveBeenCalledTimes(1);
    // ...and legitimately re-attached once more: the filmstrip's own,
    // separate camera-only copy mounting for the first time.
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(2);

    // A stops sharing: the stage tile (same key throughout) goes back to the
    // grid, back to the camera — on the SAME element the grid always used.
    const stoppedSharing = { ...a, sharing: false, screenTrack: null };
    rerenderWith([stoppedSharing, b]);
    expect(screen.queryByText("Presenting")).toBeNull();
    expect(attachedEl(a.videoTrack)).toBe(elInGrid);
  });

  it("1↔2 participant layout: the first participant's tile survives the grid's own solo→multi flip", () => {
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const { rerender } = renderRoom([a]);
    const rerenderWith = rerenderRoomFn(rerender);
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1);
    const elSolo = attachedEl(a.videoTrack);

    // A second participant joins — CallMembers' own solo/grid ternary flips.
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    rerenderWith([a, b]);

    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1); // A: not re-attached
    expect(detach(a.videoTrack)).not.toHaveBeenCalled();
    expect(attachedEl(a.videoTrack)).toBe(elSolo);
    expect(attach(b.videoTrack)).toHaveBeenCalledTimes(1); // B: a genuine, ordinary first mount
  });

  it("participant join/leave: a newcomer mounts once and a departure actually detaches, without disturbing who's left", async () => {
    const a = person("a", { camOn: true, videoTrack: fakeTrack("va") });
    const b = person("b", { camOn: true, videoTrack: fakeTrack("vb") });
    const { rerender } = renderRoom([a, b]);
    const rerenderWith = rerenderRoomFn(rerender);
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1);
    expect(attach(b.videoTrack)).toHaveBeenCalledTimes(1);
    const elForA = attachedEl(a.videoTrack);

    // C joins.
    const c = person("c", { camOn: true, videoTrack: fakeTrack("vc") });
    rerenderWith([a, b, c]);
    expect(attach(c.videoTrack)).toHaveBeenCalledTimes(1); // a real, fresh mount
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1); // A undisturbed
    expect(attach(b.videoTrack)).toHaveBeenCalledTimes(1); // B undisturbed

    // B leaves for real (dropped from the roster, same shape a real
    // ParticipantDisconnected resync produces) — this must still actually
    // detach and remove their tile; the fix only suppresses the LAYOUT-driven
    // remount, not a genuine departure.
    rerenderWith([a, c]);
    // CallTileHost's release is deliberately deferred to a microtask (see its
    // own doc) so a same-tick reclaim elsewhere always wins; a genuine
    // departure still needs that microtask to actually run before it detaches.
    await act(async () => {
      await Promise.resolve();
    });
    expect(detach(b.videoTrack)).toHaveBeenCalled();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    // A is untouched by a neighbour leaving.
    expect(attach(a.videoTrack)).toHaveBeenCalledTimes(1);
    expect(detach(a.videoTrack)).not.toHaveBeenCalled();
    expect(attachedEl(a.videoTrack)).toBe(elForA);
  });
});
