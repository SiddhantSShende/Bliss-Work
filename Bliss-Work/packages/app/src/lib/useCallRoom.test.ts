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

const h = vi.hoisted(() => ({
  rooms: [] as unknown[],
  api: {
    callToken: vi.fn(),
    leaveCall: vi.fn(async () => {}),
  },
  wsOn: vi.fn(() => () => {}),
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
    disconnect: vi.fn(async () => {
      room.emit("disconnected");
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
  useRuntime: () => ({ api: h.api, ws: { on: h.wsOn } }),
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
  h.wsOn.mockClear();
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
