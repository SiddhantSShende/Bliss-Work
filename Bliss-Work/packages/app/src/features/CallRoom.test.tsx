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
}));

// useMeetingPiP's OWN correctness (support detection, visibility handling,
// enter/exit, cleanup) is covered against real DOM stubs in
// lib/useMeetingPiP.test.ts. What's mocked here is just the wiring question:
// does CallRoom show/hide the button and call toggle().
vi.mock("../lib/useMeetingPiP", () => ({
  useMeetingPiP: () => h.pip,
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
 */
function renderRoom() {
  const qc = new QueryClient();
  const ui = (
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={() => {}} />
    </QueryClientProvider>
  );
  const result = render(ui);
  return { ...result, resync: () => result.rerender(ui) };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sendData.mockClear();
  h.pip.supported = true;
  h.pip.active = false;
  h.pip.toggle.mockClear();
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
