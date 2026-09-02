/**
 * Join defaults: camera and microphone must not be published until the user
 * asks for them.
 *
 * A real `Room` opens a WebRTC connection, which has no business in a unit
 * test, so the SFU is stood in for by a minimal fake that records what it was
 * asked to publish. Everything else (`AudioPresets`, `VideoPresets`, `Track`,
 * `RoomEvent`, ...) is the real `livekit-client` export — only the `Room`
 * class itself is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { DisconnectReason } from "livekit-client";
import { EventType, type ServerEvent, type WsEventMeta } from "@taskboard/shared";

type EventHandler = (e: ServerEvent, meta?: WsEventMeta) => void;

const h = vi.hoisted(() => ({
  rooms: [] as unknown[],
  api: {
    callToken: vi.fn(),
    leaveCall: vi.fn(async () => {}),
    callTelemetryReconnected: vi.fn(async (_callId: string) => {}),
    callTelemetrySetupComplete: vi.fn(async (_callId: string, _setupMs: number) => {}),
  },
  wsOn: vi.fn((_handler: EventHandler) => () => {}),
  // Undefined by default (the web shape: config.eventSource absent, so the
  // hook subscribes through `ws` — see the mocked runtime below). Desktop
  // tests set this to a fake EventSource to exercise the other branch.
  eventSource: undefined as undefined | { subscribe: (handler: EventHandler) => () => void },
}));

function makeFakeRoom() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const localParticipant = {
    identity: "me",
    name: "Me",
    getTrackPublication: vi.fn(() => undefined),
    setMicrophoneEnabled: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
    setScreenShareEnabled: vi.fn(async () => undefined),
    setMetadata: vi.fn(),
    publishData: vi.fn(async () => {}),
  };
  const room = {
    localParticipant,
    remoteParticipants: new Map(),
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return room;
    },
    connect: vi.fn(async () => {}),
    // Mirrors the real SDK: `room.disconnect()` always reports itself via
    // DisconnectReason.CLIENT_INITIATED (see livekit-client's Room.disconnect,
    // which sends a LeaveRequest with exactly that reason before emitting).
    // A disconnect LiveKit initiates on its own — the case under test below —
    // is simulated instead by emitting "disconnected" directly, with no
    // reason or a different one.
    disconnect: vi.fn(async () => {
      room.emit("disconnected", DisconnectReason.CLIENT_INITIATED);
    }),
    prepareConnection: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return room;
}

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    // A regular `function`, not an arrow: this stands in for a class that gets
    // called with `new`, and only a real function is constructible.
    Room: vi.fn().mockImplementation(function () {
      const room = makeFakeRoom();
      h.rooms.push(room);
      return room;
    }),
  };
});

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    api: h.api,
    ws: { on: h.wsOn },
    config: { eventSource: h.eventSource },
  }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

import { useCallRoom } from "./useCallRoom";

const CALL_ID = "call-1";
const grant = () => ({
  state: "JOINED" as const,
  url: "wss://sfu.test",
  token: "tok",
  room: "room-1",
  identity: "me",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  role: "PARTICIPANT" as const,
});

let unmount: (() => void) | null = null;

beforeEach(() => {
  h.rooms.length = 0;
  h.api.callToken.mockReset().mockResolvedValue(grant());
  h.api.leaveCall.mockClear();
  h.api.callTelemetryReconnected.mockClear();
  h.api.callTelemetrySetupComplete.mockClear();
  h.wsOn.mockClear();
  h.eventSource = undefined;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/** Renders the hook and drives it through a real join, returning the fake
 *  room the (mocked) `Room` constructor produced for it. */
async function joined() {
  const rendered = renderHook(() => useCallRoom(CALL_ID));
  unmount = rendered.unmount;
  await act(async () => {
    await rendered.result.current.join();
  });
  await waitFor(() => expect(rendered.result.current.status).toBe("connected"));
  return { ...rendered, room: h.rooms[0] as ReturnType<typeof makeFakeRoom> };
}

describe("joining a call", () => {
  it("does not publish the camera or microphone", async () => {
    const { room } = await joined();
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("reports the microphone off", async () => {
    const { result } = await joined();
    expect(result.current.micOn).toBe(false);
  });

  it("reports the camera off", async () => {
    const { result } = await joined();
    expect(result.current.camOn).toBe(false);
  });
});

describe("reconnecting", () => {
  it("does not re-enable the camera or microphone", async () => {
    const { result, room } = await joined();

    act(() => room.emit("reconnecting"));
    expect(result.current.status).toBe("reconnecting");

    act(() => room.emit("reconnected"));
    await waitFor(() => expect(result.current.status).toBe("connected"));

    expect(result.current.micOn).toBe(false);
    expect(result.current.camOn).toBe(false);
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });
});

function callEndedEvent(): ServerEvent {
  return {
    type: EventType.CallEnded,
    eventId: "55555555-5555-5555-5555-555555555555",
    occurredAt: new Date().toISOString(),
    orgId: "66666666-6666-6666-6666-666666666666",
    callId: CALL_ID,
    kind: "MEETING",
    actorId: "host",
    title: "Weekly review",
  } as ServerEvent;
}

/**
 * Regression coverage for the desktop "meeting window never closes when the
 * organiser ends it" bug: `useCallRoom` used to subscribe via `ws.on(...)`
 * unconditionally, but on Electron nothing ever calls `ws.connect()` — real
 * events arrive over `config.eventSource` (the IPC bridge to the
 * utilityProcess) instead, the same split `queryBridge.tsx`'s WsEventBridge
 * already branches on. A `ws.on` subscription was therefore permanently dead
 * on desktop: CallEnded never reached this hook, the room was never told to
 * disconnect, and the call screen never closed on its own.
 */
describe("the call ending under us", () => {
  it("disconnects the room when CallEnded arrives over ws — the web path (no config.eventSource)", async () => {
    const { result, room } = await joined();
    expect(h.wsOn).toHaveBeenCalled();
    const handler = h.wsOn.mock.calls.at(-1)![0];

    act(() => handler(callEndedEvent(), undefined));

    await waitFor(() => expect(result.current.ended).toBe(true));
    expect(room.disconnect).toHaveBeenCalled();
  });

  it("disconnects the room when CallEnded arrives over config.eventSource — the desktop path — and never touches ws, which is never connected there", async () => {
    const subscribe = vi.fn((_handler: EventHandler) => () => {});
    h.eventSource = { subscribe };
    const { result, room } = await joined();

    expect(subscribe).toHaveBeenCalled();
    expect(h.wsOn).not.toHaveBeenCalled();
    const handler = subscribe.mock.calls.at(-1)![0];

    act(() => handler(callEndedEvent(), undefined));

    await waitFor(() => expect(result.current.ended).toBe(true));
    expect(room.disconnect).toHaveBeenCalled();
  });
});

describe("call telemetry", () => {
  it("reports setup duration once, right after connecting", async () => {
    await joined();
    expect(h.api.callTelemetrySetupComplete).toHaveBeenCalledTimes(1);
    const [calledCallId, setupMs] = h.api.callTelemetrySetupComplete.mock.calls[0]!;
    expect(calledCallId).toBe(CALL_ID);
    expect(setupMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a reconnect only when the room actually reconnects", async () => {
    const { room } = await joined();
    expect(h.api.callTelemetryReconnected).not.toHaveBeenCalled();

    act(() => room.emit("reconnecting"));
    expect(h.api.callTelemetryReconnected).not.toHaveBeenCalled();

    act(() => room.emit("reconnected"));
    expect(h.api.callTelemetryReconnected).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });

  /** Regression test: an earlier version called these unguarded, and a
   *  mock/consumer without the method (or any other synchronous throw) took
   *  the whole join down with it — a call that had just connected successfully
   *  was reported to the user as "failed" purely because of a telemetry bug. */
  it("a telemetry call that throws does not affect join status", async () => {
    h.api.callTelemetrySetupComplete.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { result } = await joined();
    expect(result.current.status).toBe("connected");
  });

  it("a telemetry call that rejects does not affect reconnect status", async () => {
    h.api.callTelemetryReconnected.mockRejectedValueOnce(new Error("boom"));
    const { result, room } = await joined();

    act(() => room.emit("reconnecting"));
    act(() => room.emit("reconnected"));

    await waitFor(() => expect(result.current.status).toBe("connected"));
  });
});

describe("existing controls", () => {
  it("can still turn the microphone on", async () => {
    const { result, room } = await joined();

    await act(async () => {
      await result.current.toggleMic();
    });

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(result.current.micOn).toBe(true);
  });

  it("can still turn the camera on", async () => {
    const { result, room } = await joined();

    await act(async () => {
      await result.current.toggleCam();
    });

    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(result.current.camOn).toBe(true);
  });
});

const CALL_ID_B = "call-2";

/**
 * Regression coverage for a second call silently taking over the UI while
 * the actual LiveKit connection stayed on the first: CallRoom is
 * deliberately never unmounted between calls (see lib/MeetingSession's
 * `enter`), so switching — accepting a second incoming invite while
 * minimised, starting a call in a different channel, joining a different
 * call from the Meetings list — only changes this hook's `callId` prop.
 * join()'s reentry guard used to be `roomRef.current || joining.current`,
 * which cannot tell "the SAME call, already connected" apart from "a
 * DIFFERENT call took over" and silently no-opped the latter: the video
 * stayed on the old call while everything UI-driven (title, roster) moved to
 * the new one, and a later Leave posted the departure under the NEW call's
 * id instead of the old one's.
 */
describe("switching to a different call while still connected", () => {
  it("leaves the old room under its own id, connects the new one, and reports the new call's own eventual leave separately", async () => {
    const rendered = renderHook(({ id }: { id: string }) => useCallRoom(id), {
      initialProps: { id: CALL_ID },
    });
    unmount = rendered.unmount;

    await act(async () => {
      await rendered.result.current.join();
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("connected"));
    const roomA = h.rooms[0] as ReturnType<typeof makeFakeRoom>;

    // CallRoom's own join effect re-fires `join()` off the new `call.id` —
    // simulated the same way here rather than through CallRoom itself, same
    // as every other test in this file.
    rendered.rerender({ id: CALL_ID_B });
    await act(async () => {
      await rendered.result.current.join();
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("connected"));
    const roomB = h.rooms[1] as ReturnType<typeof makeFakeRoom>;

    expect(roomB).not.toBe(roomA);
    expect(roomA.disconnect).toHaveBeenCalledTimes(1);
    expect(roomB.connect).toHaveBeenCalledTimes(1);

    // The leave record belongs to A — the call this identity actually
    // vacated — not B, which it was never really connected to.
    expect(h.api.leaveCall).toHaveBeenCalledExactlyOnceWith(CALL_ID);

    // And B's OWN eventual leave still gets reported: the "already told the
    // server" flag has to reset when a fresh call is joined, or nothing
    // would ever tell the server about B once A had already consumed it.
    await act(async () => {
      await rendered.result.current.leave();
    });
    expect(roomB.disconnect).toHaveBeenCalledTimes(1);
    expect(h.api.leaveCall).toHaveBeenCalledTimes(2);
    expect(h.api.leaveCall).toHaveBeenNthCalledWith(2, CALL_ID_B);
  });

  it("does not no-op a switch even while the old room is still only in the waiting lobby", async () => {
    h.api.callToken.mockResolvedValueOnce({ state: "WAITING", canStart: false });
    const rendered = renderHook(({ id }: { id: string }) => useCallRoom(id), {
      initialProps: { id: CALL_ID },
    });
    unmount = rendered.unmount;

    await act(async () => {
      await rendered.result.current.join();
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("waiting"));

    rendered.rerender({ id: CALL_ID_B });
    await act(async () => {
      await rendered.result.current.join();
    });
    await waitFor(() => expect(rendered.result.current.status).toBe("connected"));

    expect(h.rooms).toHaveLength(1);
    expect((h.rooms[0] as ReturnType<typeof makeFakeRoom>).connect).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression coverage for a mid-call network failure that outlasts
 * LiveKit's own reconnection (see the "reconnecting" describe block above
 * for the RECOVERED case) leaving the participant stuck: the Disconnected
 * handler used to treat every disconnect identically — status reset to
 * "idle", no error, and (since leave()'s own no-room branch only reports for
 * status "waiting") the server was never told they had gone. Every control
 * (mic/camera/share) silently no-ops on a null room from that point on.
 */
describe("a disconnect LiveKit's own reconnection gave up on", () => {
  it("surfaces a failed state instead of silently going idle, and tells the server we left", async () => {
    const { result, room } = await joined();

    // The real SDK reports this with some non-CLIENT_INITIATED reason (a
    // server-side SERVER_SHUTDOWN/ROOM_DELETED/etc.) or with none at all —
    // see livekit-client's RTCEngine, which emits plain `Disconnected` with
    // no reason once it gives up retrying. Neither was ever preceded by
    // this hook calling `leave()` or `room.disconnect()` itself.
    act(() => room.emit("disconnected", DisconnectReason.SERVER_SHUTDOWN));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.failStage).toBe("disconnected");
    expect(result.current.participants).toEqual([]);
    expect(h.api.leaveCall).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });

  it("also surfaces failed when the SDK reports no reason at all — the actual shape of giving up on reconnection", async () => {
    const { result, room } = await joined();

    act(() => room.emit("disconnected"));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(h.api.leaveCall).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });
});

describe("an app-initiated leave", () => {
  it("still behaves exactly as before: lands on idle with no error, and reports the leave exactly once", async () => {
    const { result, room } = await joined();

    await act(async () => {
      await result.current.leave();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.failStage).toBeNull();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(h.api.leaveCall).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });
});
