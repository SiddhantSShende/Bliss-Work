/**
 * Two guarantees that only show up once the room is actually assembled:
 *
 *  - the automatic speaker's silence timeout fires on its own clock, not only
 *    when the SFU reports a change in who is speaking (see lib/activeSpeaker
 *    for the filter itself, and its own tests for the state machine in
 *    isolation);
 *  - a manual pin never leaves this client. `sendData` is the only way
 *    anything in this room reaches other participants, so a pin that never
 *    calls it cannot have been broadcast.
 *
 * `useCallRoom` is replaced with a small controllable fake — the real hook's
 * own behaviour (join defaults, reconnect, toggles) is covered directly in
 * lib/useCallRoom.test.ts. What's under test here is CallRoom's own wiring:
 * the speaker-filter tick, and the stage/grid/pin logic built on top of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import type { RoomParticipant } from "../lib/useCallRoom";
import { PROMOTE_AFTER_MS, DEMOTE_AFTER_MS } from "../lib/activeSpeaker";

const h = vi.hoisted(() => ({
  sendData: vi.fn(),
  participants: [] as RoomParticipant[],
  pip: { supported: true, active: false, toggle: vi.fn() },
  // Captures every call CallRoom makes into the hook, so tests can both
  // inspect what track it computed (the pipTrack self-share exclusion) and
  // invoke the onAway/onBack callbacks it wired up (the minimise coupling) —
  // without needing useMeetingPiP's own DOM-level visibility/blur plumbing,
  // which is covered on its own terms in lib/useMeetingPiP.test.ts.
  useMeetingPiP: vi.fn(),
  session: null as null | {
    minimized: boolean;
    minimize: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  },
}));

// useMeetingPiP's OWN correctness (support detection, visibility handling,
// enter/exit, cleanup) is covered against real DOM stubs in
// lib/useMeetingPiP.test.ts. What's mocked here is just the wiring question:
// does CallRoom show/hide the button, call toggle(), pass the right track,
// and react to onAway/onBack.
vi.mock("../lib/useMeetingPiP", () => ({
  useMeetingPiP: (...args: unknown[]) => {
    h.useMeetingPiP(...args);
    return h.pip;
  },
}));

// No MeetingSessionProvider wraps these tests (renderRoom is deliberately
// bare — most of this file exercises the room with nowhere to minimise
// into). The minimise-coupling tests below opt into a session by setting
// `h.session` themselves.
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSessionOptional: () => h.session,
}));

vi.mock("../lib/useCallRoom", () => ({
  useCallRoom: () => ({
    status: "connected",
    participants: h.participants,
    micOn: false,
    camOn: false,
    sharing: false,
    connectedAt: Date.now(),
    canStart: false,
    ended: false,
    join: vi.fn(),
    start: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    toggleMic: vi.fn(),
    toggleCam: vi.fn(),
    toggleShare: vi.fn(),
    addPeople: vi.fn(async () => {}),
    sendData: h.sendData,
    onData: vi.fn(() => () => {}),
    identity: "me",
  }),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: { stopCallRecording: vi.fn(), startCallRecording: vi.fn() } }),
}));

vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ user: { id: "me", displayName: "Me" } }),
}));

import { CallRoom } from "./CallRoom";

function participant(over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity: "p",
    name: "P",
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

const call: CallDTO = {
  id: "call-1",
  orgId: "org-1",
  kind: "MEETING",
  channelId: null,
  title: "Standup",
  media: "video",
  createdBy: "me",
  scheduledAt: new Date(0).toISOString(),
  endsAt: null,
  startedAt: null,
  startedBy: null,
  endedAt: null,
  status: "LIVE",
  createdAt: new Date(0).toISOString(),
  participants: [],
  activeShares: [],
  recordingStatus: null,
};

/**
 * Advances fake time in small steps, flushing (via `act`) after each one.
 *
 * `CallRoom`'s tick fires via a real `setInterval`, spaced far enough apart
 * that production always gets a full render between firings. A single large
 * `vi.advanceTimersByTimeAsync` call fires every due interval callback before
 * yielding, so their queued state updates get resolved together against
 * whichever `speakingRef` value was current at the START of that batch —
 * which is exactly the staleness this tick exists to prevent, just relocated
 * into the test harness. Stepping finely and flushing between steps restores
 * the one-render-per-tick shape the interval actually has in the browser.
 */
async function tick(totalMs: number, stepMs = 50) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

/**
 * Renders the room and returns `resync()` — re-renders the SAME instance so a
 * later mutation of `h.participants` is picked up without remounting (which
 * would reset the very speaker state the timeout test needs to observe change
 * over time).
 *
 * Also clicks through the pre-join lobby: CallRoom always mounts into it
 * first (see its own `preJoin` state), and nothing under test here is about
 * that screen — jsdom has no `navigator.mediaDevices`, so the camera preview
 * effect no-ops and the only way out is the "Join meeting" button.
 */
function renderRoom() {
  const qc = new QueryClient();
  const ui = (
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={() => {}} />
    </QueryClientProvider>
  );
  const result = render(ui);
  act(() => {
    screen.getByRole("button", { name: "Join meeting" }).click();
  });
  return { ...result, resync: () => result.rerender(ui) };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sendData.mockClear();
  h.pip.supported = true;
  h.pip.active = false;
  h.pip.toggle.mockClear();
  h.useMeetingPiP.mockClear();
  h.session = null;
  h.participants = [
    participant({ identity: "me", isLocal: true, name: "Me" }),
    participant({ identity: "alice", name: "Alice" }),
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the automatic speaker's silence timeout", () => {
  it("promotes a sustained speaker and later releases to the grid, purely from elapsed time", async () => {
    // Alice speaks continuously — the participant list never changes again
    // until she stops, so nothing here re-triggers CallRoom's speaking-set
    // effect. Only the periodic tick can be responsible for what happens next.
    h.participants = [
      participant({ identity: "me", isLocal: true, name: "Me" }),
      participant({ identity: "alice", name: "Alice", speaking: true }),
    ];
    const { resync } = renderRoom();

    expect(screen.queryByText("Speaking")).toBeNull();

    await tick(PROMOTE_AFTER_MS + 300);
    expect(screen.getByText("Speaking")).toBeInTheDocument();

    // Alice actually stops — a real, one-time speaking event — and CallRoom
    // re-renders to pick it up.
    h.participants = [
      participant({ identity: "me", isLocal: true, name: "Me" }),
      participant({ identity: "alice", name: "Alice", speaking: false }),
    ];
    act(() => resync());
    // The breath grace period: alice keeps the stage immediately after.
    expect(screen.getByText("Speaking")).toBeInTheDocument();

    // No further speaking event ever arrives from here on — only the clock
    // advances, via CallRoom's own tick.
    await tick(DEMOTE_AFTER_MS + 300);
    expect(screen.queryByText("Speaking")).toBeNull();
  });
});

describe("manual pin", () => {
  it("never reaches sendData — pinning stays local to this client", async () => {
    h.participants = [
      participant({ identity: "me", isLocal: true, name: "Me" }),
      participant({ identity: "alice", name: "Alice" }),
    ];
    renderRoom();

    const before = h.sendData.mock.calls.length;
    await act(async () => {
      screen.getByRole("button", { name: "Pin Alice" }).click();
    });

    expect(screen.getByRole("button", { name: "Unpin Alice" })).toBeInTheDocument();
    expect(h.sendData.mock.calls.length).toBe(before);
  });
});

describe("the manual picture-in-picture button", () => {
  it("is offered when the platform supports it, and toggles on click", async () => {
    h.pip.supported = true;
    renderRoom();

    const button = screen.getByRole("button", { name: "Picture-in-picture" });
    await act(async () => {
      button.click();
    });
    expect(h.pip.toggle).toHaveBeenCalledTimes(1);
  });

  it("is not offered at all when the platform has no Picture-in-Picture support", () => {
    h.pip.supported = false;
    renderRoom();

    expect(screen.queryByRole("button", { name: /picture-in-picture/i })).toBeNull();
  });

  it("reflects an active PiP session in its label", () => {
    h.pip.supported = true;
    h.pip.active = true;
    renderRoom();

    expect(screen.getByRole("button", { name: "Exit picture-in-picture" })).toBeInTheDocument();
  });
});

/** The (track, enabled, callbacks) arguments from CallRoom's most recent call
 *  into the mocked hook — everything the two suites below need to inspect. */
function lastPipCall() {
  const call = h.useMeetingPiP.mock.calls.at(-1) as
    | [unknown, unknown, { onAway?: () => void; onBack?: () => void }]
    | undefined;
  return { track: call?.[0], callbacks: call?.[2] };
}

describe("Picture-in-Picture track selection", () => {
  it("excludes the local participant's own shared screen — showing it back to yourself is the mirror-loop bug", () => {
    const screenTrack = { id: "my-screen" } as unknown as RoomParticipant["screenTrack"];
    h.participants = [
      participant({ identity: "me", isLocal: true, name: "Me", sharing: true, screenTrack }),
    ];
    renderRoom();

    expect(lastPipCall().track).toBeNull();
  });

  it("still follows a REMOTE participant's shared screen", () => {
    // CallTile itself renders (unmocked) for whoever lands on stage, and
    // attaches this to a real <video> element — needs the same attach/detach
    // shape as a livekit-client Track, not just an identity to compare.
    const screenTrack = {
      id: "alice-screen",
      attach: vi.fn(),
      detach: vi.fn(),
    } as unknown as RoomParticipant["screenTrack"];
    h.participants = [
      participant({ identity: "me", isLocal: true, name: "Me" }),
      participant({ identity: "alice", name: "Alice", sharing: true, screenTrack }),
    ];
    renderRoom();

    expect(lastPipCall().track).toBe(screenTrack);
  });
});

describe("switching away from the window minimises the room", () => {
  it("minimises on the first onAway, and restores on the matching onBack", () => {
    const session = { minimized: false, minimize: vi.fn(), restore: vi.fn() };
    h.session = session;
    renderRoom();

    act(() => lastPipCall().callbacks?.onAway?.());
    expect(session.minimize).toHaveBeenCalledTimes(1);

    act(() => lastPipCall().callbacks?.onBack?.());
    expect(session.restore).toHaveBeenCalledTimes(1);
  });

  it("leaves a meeting the user already minimised on purpose alone — onAway does not re-minimise it, and onBack does not pop it back open", () => {
    const session = { minimized: true, minimize: vi.fn(), restore: vi.fn() };
    h.session = session;
    renderRoom();

    act(() => lastPipCall().callbacks?.onAway?.());
    expect(session.minimize).not.toHaveBeenCalled();

    act(() => lastPipCall().callbacks?.onBack?.());
    expect(session.restore).not.toHaveBeenCalled();
  });
});
