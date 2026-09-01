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
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import type { RoomParticipant } from "../lib/useCallRoom";
import { PROMOTE_AFTER_MS, DEMOTE_AFTER_MS } from "../lib/activeSpeaker";

const h = vi.hoisted(() => ({
  sendData: vi.fn(),
  toggleMic: vi.fn(),
  toggleCam: vi.fn(),
  participants: [] as RoomParticipant[],
  pip: {
    supported: true,
    active: false,
    toggle: vi.fn(),
    enter: vi.fn(async () => true),
    exit: vi.fn(async () => {}),
  },
  // Captures every call CallRoom makes into the hook, so tests can inspect
  // what track it computed (the pipTrack self-share exclusion) — without
  // needing useMeetingPiP's own DOM-level PiP plumbing, which is covered on
  // its own terms in lib/useMeetingPiP.test.ts.
  useMeetingPiP: vi.fn(),
  display: { mode: "NORMAL" as "NORMAL" | "MINIMIZED" | "PICTURE_IN_PICTURE", handleMinimize: vi.fn() },
  // Same idea for the display controller: its OWN state machine (the
  // USER_AWAY/USER_RETURNED → PiP/minimize flow, the mutual-exclusion
  // invariant, restoring the right prior mode) is covered exhaustively in
  // lib/useMeetingDisplayController.test.ts. What's mocked here is just
  // whether CallRoom wires it up with the right session/pip/enabled and
  // renders correctly off `mode`/`handleMinimize`.
  useMeetingDisplayController: vi.fn(),
  session: null as null | {
    minimized: boolean;
    minimize: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  },
}));

// useMeetingPiP's OWN correctness (support detection, PiP mechanics,
// cleanup) is covered against real DOM stubs in lib/useMeetingPiP.test.ts.
// What's mocked here is just the wiring question: does CallRoom show/hide
// the button, call toggle(), and pass the right track.
vi.mock("../lib/useMeetingPiP", () => ({
  useMeetingPiP: (...args: unknown[]) => {
    h.useMeetingPiP(...args);
    return h.pip;
  },
}));

vi.mock("../lib/useMeetingDisplayController", () => ({
  useMeetingDisplayController: (...args: unknown[]) => {
    h.useMeetingDisplayController(...args);
    return h.display;
  },
}));

// No MeetingSessionProvider wraps these tests (renderRoom is deliberately
// bare — most of this file exercises the room with nowhere to minimise
// into). The display-controller-wiring tests below opt into a session by
// setting `h.session` themselves.
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSessionOptional: () => h.session,
}));

vi.mock("../lib/useCallRoom", async (importOriginal) => ({
  // isGetUserMediaDenied is real — it's a pure classifier the pre-join
  // preview effect calls directly, unrelated to the room connection itself.
  ...(await importOriginal<typeof import("../lib/useCallRoom")>()),
  useCallRoom: () => ({
    status: "connected",
    participants: h.participants,
    micOn: false,
    camOn: false,
    sharing: false,
    // This client's own connect time — deliberately NOT what the meeting
    // timer should be built from (see the "meeting timer" describe block
    // below); a value distinguishable from call.startedAt is the point.
    connectedAt: Date.now(),
    canStart: false,
    ended: false,
    join: vi.fn(),
    start: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    toggleMic: h.toggleMic,
    toggleCam: h.toggleCam,
    toggleShare: vi.fn(),
    addPeople: vi.fn(async () => {}),
    sendData: h.sendData,
    onData: vi.fn(() => () => {}),
    identity: "me",
  }),
}));

vi.mock("../lib/runtime", () => ({
  // `config` mirrors the web build: no Electron-only capabilities present, so
  // CallRoom's presence-gated calls (onBeforeQuit, openCameraSettings, …)
  // correctly no-op instead of throwing on undefined.
  useRuntime: () => ({ api: { stopCallRecording: vi.fn(), startCallRecording: vi.fn() }, config: {} }),
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
 * `resync` builds the element FRESH on every call rather than reusing one
 * closed-over JSX literal: React bails out of reconciling a subtree when the
 * element (and its props object) handed down through `rerender` is the exact
 * same object reference as last time, which a reused literal always is. That
 * bailout is invisible to tests whose only path back into CallRoom is an
 * internal state update (a click, `tick()`'s fake-timer-driven interval) —
 * those cause CallRoom to re-render itself regardless of what `rerender` was
 * given — but it silently no-ops a test that mutates an external mock (a
 * hoisted `h.session`/`h.pip` field) and expects `resync()` alone to surface
 * it.
 *
 * Also clicks through the pre-join lobby: CallRoom always mounts into it
 * first (see its own `preJoin` state), and nothing under test here is about
 * that screen — jsdom has no `navigator.mediaDevices`, so the camera preview
 * effect no-ops and the only way out is the "Join meeting" button.
 *
 * `muteBeforeJoin`/`cameraOffBeforeJoin` click the lobby's own toggles before
 * joining — both default to on (see CallRoom's previewMicOn/previewCamOn), so
 * leaving these false exercises the common "left both on" path.
 */
function renderRoom(opts: { muteBeforeJoin?: boolean; cameraOffBeforeJoin?: boolean } = {}) {
  const qc = new QueryClient();
  const build = () => (
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={() => {}} />
    </QueryClientProvider>
  );
  const result = render(build());
  act(() => {
    if (opts.muteBeforeJoin) screen.getByRole("button", { name: "Mute microphone" }).click();
    if (opts.cameraOffBeforeJoin) screen.getByRole("button", { name: "Turn camera off" }).click();
    screen.getByRole("button", { name: "Join meeting" }).click();
  });
  return { ...result, resync: () => result.rerender(build()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sendData.mockClear();
  h.toggleMic.mockClear();
  h.toggleCam.mockClear();
  h.pip.supported = true;
  h.pip.active = false;
  h.pip.toggle.mockClear();
  h.pip.enter = vi.fn(async () => true);
  h.pip.exit = vi.fn(async () => {});
  h.useMeetingPiP.mockClear();
  h.display.mode = "NORMAL";
  h.display.handleMinimize = vi.fn();
  h.useMeetingDisplayController.mockClear();
  h.session = null;
  h.participants = [
    participant({ identity: "me", isLocal: true, name: "Me" }),
    participant({ identity: "alice", name: "Alice" }),
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the meeting timer", () => {
  it("counts from the MEETING's own start time, not from this client's own connect — every participant must read the same number", () => {
    // The mocked useCallRoom reports connectedAt as "right now" (this test's
    // fake-timer clock), simulating a participant who joined late; the
    // meeting itself started 65s earlier, per the server-authoritative
    // call.startedAt. The timer must reflect the LATTER.
    const now = Date.now();
    const lateJoinerCall = { ...call, startedAt: new Date(now - 65_000).toISOString() };
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <CallRoom call={lateJoinerCall} onClose={() => {}} />
      </QueryClientProvider>,
    );
    act(() => {
      screen.getByRole("button", { name: "Join meeting" }).click();
    });

    // Synchronous: useCallDuration sets its first `now` inside a mount-time
    // effect, which `act` above already flushed — no ticking needed to see
    // it, and `findByText`'s polling wouldn't fire anyway under fake timers.
    expect(screen.getByText("1:05")).toBeInTheDocument();
  });

  it("shows nothing before the meeting has actually started (no server startedAt yet)", () => {
    renderRoom(); // the shared `call` fixture has startedAt: null
    expect(screen.queryByText(/^\d+:\d\d$/)).toBeNull();
  });
});

/**
 * Regression coverage for a false "Camera and microphone are blocked" in the
 * pre-join lobby: React StrictMode's synchronous mount→cleanup→mount fires
 * the preview effect twice, so every dev/staging visit to the lobby issues
 * two overlapping getUserMedia calls. The `.then()` branch already ignored a
 * stale (cancelled) attempt's result; `.catch()` did not, so a late
 * rejection from the FIRST, abandoned attempt could stomp a working preview
 * that the SECOND, current attempt had already produced.
 */
describe("the pre-join camera/mic preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a stale attempt's late rejection once a later attempt has already produced a working preview", async () => {
    const pending: Array<{ resolve: (s: MediaStream) => void; reject: (e: unknown) => void }> = [];
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const qc = new QueryClient();
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <CallRoom call={call} onClose={() => {}} />
        </QueryClientProvider>
      </StrictMode>,
    );

    // StrictMode's double-invoke is synchronous — both the abandoned first
    // mount and the real second mount have already started their own call.
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    // The SECOND (current) attempt succeeds first...
    await act(async () => pending.at(1)!.resolve(fakeStream));
    // ...and only THEN does the FIRST (abandoned) attempt's rejection land.
    await act(async () => pending.at(0)!.reject(new DOMException("device busy", "NotReadableError")));

    expect(screen.queryByText("Camera and microphone are blocked")).toBeNull();
    expect(screen.queryByText("Couldn't access your camera or microphone")).toBeNull();
  });

  /**
   * Regression coverage for a second false "blocked" banner: CallRoom is
   * never remounted between calls (see CallRoomLazy — it keeps one instance
   * alive across surfaces so the LiveKit connection survives), so a denial
   * left over from a PRIOR call must not bleed into a later call's lobby.
   * Before this fix, the preview effect only re-ran on `preJoin`/
   * `previewAttempt`, so switching `call` while still on the lobby kept
   * showing the previous call's stale "denied" state without ever asking
   * for permission again.
   */
  it("re-checks permission instead of reusing a previous call's denial when the call itself changes", async () => {
    const pending: Array<{ resolve: (s: MediaStream) => void; reject: (e: unknown) => void }> = [];
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const qc = new QueryClient();
    const build = (c: CallDTO) => (
      <QueryClientProvider client={qc}>
        <CallRoom call={c} onClose={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(build(call));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.reject(new DOMException("denied", "NotAllowedError")));
    expect(screen.getByText("Camera and microphone are blocked")).toBeInTheDocument();

    // Routed into a different call while still sitting on the lobby (e.g.
    // accepting a new incoming meeting) — a fresh permission check must
    // fire rather than trusting the previous call's denial.
    rerender(build({ ...call, id: "call-2" }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    await act(async () => pending[1]!.resolve(fakeStream));

    expect(screen.queryByText("Camera and microphone are blocked")).toBeNull();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn camera off" })).toBeInTheDocument();
  });
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

describe("the pre-join lobby's mic/camera choice", () => {
  it("publishes both once connected when the lobby left them on — the default", async () => {
    renderRoom();
    await act(async () => {});
    expect(h.toggleMic).toHaveBeenCalledTimes(1);
    expect(h.toggleCam).toHaveBeenCalledTimes(1);
  });

  it("leaves the mic off when it was muted in the lobby before joining", async () => {
    renderRoom({ muteBeforeJoin: true });
    await act(async () => {});
    expect(h.toggleMic).not.toHaveBeenCalled();
    expect(h.toggleCam).toHaveBeenCalledTimes(1);
  });

  it("leaves the camera off when it was turned off in the lobby before joining", async () => {
    renderRoom({ cameraOffBeforeJoin: true });
    await act(async () => {});
    expect(h.toggleMic).toHaveBeenCalledTimes(1);
    expect(h.toggleCam).not.toHaveBeenCalled();
  });

  it("does not also apply the lobby's (untouched, default-on) choice when autoJoin already picked one", async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <CallRoom call={call} onClose={() => {}} autoJoin="voice" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    // autoJoin="voice" is the mic-only path (see CallRoom's autoJoin effect).
    expect(h.toggleMic).toHaveBeenCalledTimes(1);
    expect(h.toggleCam).not.toHaveBeenCalled();
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
    // Two pin controls exist for the same person now: one on her video tile,
    // one on her row in the always-visible Participants list. Either toggles
    // the same shared pin state, so only the first needs a click.
    // `getAllByRole` throws if nothing matches, so a match here is never
    // actually undefined — the assertion just says so to the type checker.
    const firstPinButton = screen.getAllByRole("button", { name: "Pin Alice" }).at(0)!;
    await act(async () => {
      firstPinButton.click();
    });

    expect(screen.getAllByRole("button", { name: "Unpin Alice" }).length).toBeGreaterThan(0);
    expect(h.sendData.mock.calls.length).toBe(before);
  });
});

describe("the manual picture-in-picture button", () => {
  it("is offered when the platform supports it, and toggles on click", async () => {
    h.pip.supported = true;
    renderRoom();

    // Picture-in-picture now lives in the "More" menu (see CallMoreMenu) —
    // either of the two instances (top cluster, bottom bar) offers the same
    // items, so opening the first is enough.
    await act(async () => {
      // `getAllByRole` throws if nothing matches, so this is never actually
      // undefined — the assertion just says so to the type checker.
      screen.getAllByRole("button", { name: "More" }).at(0)!.click();
    });
    const button = screen.getByRole("menuitem", { name: "Picture-in-picture" });
    await act(async () => {
      button.click();
    });
    expect(h.pip.toggle).toHaveBeenCalledTimes(1);
  });

  it("still offers the invite link when the platform has no Picture-in-Picture support", async () => {
    h.pip.supported = false;
    renderRoom();

    // The invite link is a normally-available action (this MEETING-kind call
    // is connected), so unlike PiP/Minimise it keeps the More button around
    // even with nothing else to offer.
    await act(async () => {
      screen.getAllByRole("button", { name: "More" }).at(0)!.click();
    });
    expect(screen.getByRole("menuitem", { name: "Copy invite link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Picture-in-picture" })).toBeNull();
  });

  it("reflects an active PiP session in its label", async () => {
    h.pip.supported = true;
    h.pip.active = true;
    renderRoom();

    await act(async () => {
      // `getAllByRole` throws if nothing matches, so this is never actually
      // undefined — the assertion just says so to the type checker.
      screen.getAllByRole("button", { name: "More" }).at(0)!.click();
    });
    expect(screen.getByRole("menuitem", { name: "Exit picture-in-picture" })).toBeInTheDocument();
  });
});

/** The (track, enabled) arguments from CallRoom's most recent call into the
 *  mocked PiP hook. */
function lastPipCall() {
  const call = h.useMeetingPiP.mock.calls.at(-1) as [unknown, unknown] | undefined;
  return { track: call?.[0] };
}

/** The (session, pip, enabled) arguments from CallRoom's most recent call
 *  into the mocked display controller. */
function lastControllerCall() {
  const call = h.useMeetingDisplayController.mock.calls.at(-1) as
    | [unknown, unknown, unknown]
    | undefined;
  return { session: call?.[0], pip: call?.[1], enabled: call?.[2] };
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

/**
 * The display controller's OWN correctness — how a USER_AWAY/USER_RETURNED
 * signal turns into a PiP attempt with a minimise fallback, the mutual
 * exclusion invariant, restoring the right prior mode — is exhaustively
 * covered in lib/useMeetingDisplayController.test.ts against a real
 * userBehaviorAnalysis subscription. What's left to prove here is only that
 * CallRoom actually WIRES UP that controller (the right session, the right
 * pip, gated the right way) and renders off what it returns.
 */
describe("the meeting display controller", () => {
  it("is handed this room's own session and pip instance, gated on the call being connected", () => {
    const session = { minimized: false, minimize: vi.fn(), restore: vi.fn() };
    h.session = session;
    renderRoom();

    const call = lastControllerCall();
    expect(call.session).toBe(session);
    expect(call.pip).toBe(h.pip);
    expect(call.enabled).toBe(true); // the mocked useCallRoom reports status "connected"
  });

  it("renders the floating mini-card and hides the full room when the controller reports MINIMIZED", () => {
    h.session = { minimized: true, minimize: vi.fn(), restore: vi.fn() };
    h.display.mode = "MINIMIZED";
    renderRoom();

    expect(screen.getByLabelText(/meeting in progress/i)).toBeInTheDocument();
  });

  it("shows the full room, not the mini-card, whenever the controller reports NORMAL or PICTURE_IN_PICTURE", () => {
    h.session = { minimized: false, minimize: vi.fn(), restore: vi.fn() };
    h.display.mode = "PICTURE_IN_PICTURE";
    renderRoom();

    expect(screen.queryByLabelText(/meeting in progress/i)).toBeNull();
  });

  it("routes the Minimise button through the controller's handleMinimize, not session.minimize directly", async () => {
    const session = { minimized: false, minimize: vi.fn(), restore: vi.fn() };
    h.session = session;
    renderRoom();

    // Minimise now lives in the "More" menu (see CallMoreMenu).
    await act(async () => {
      // `getAllByRole` throws if nothing matches, so this is never actually
      // undefined — the assertion just says so to the type checker.
      screen.getAllByRole("button", { name: "More" }).at(0)!.click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "Minimise" }).click();
    });

    expect(h.display.handleMinimize).toHaveBeenCalledTimes(1);
    expect(session.minimize).not.toHaveBeenCalled(); // only the controller's own version is
  });
});
