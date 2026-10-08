import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomParticipant } from "./useCallRoom";

const rec = vi.hoisted(() => ({
  options: undefined as { onError: (e: unknown) => void } | undefined,
  stop: vi.fn(async () => {}),
  update: vi.fn(),
}));

vi.mock("./localRecording", () => ({
  canRecordLocally: () => true,
  startLocalRecording: (o: { onError: (e: unknown) => void }) => {
    rec.options = o;
    return { stop: rec.stop, update: rec.update };
  },
}));

import { useLocalRecording } from "./useLocalRecording";

beforeEach(() => {
  rec.options = undefined;
  rec.stop.mockClear();
  rec.update.mockClear();
});

describe("useLocalRecording", () => {
  it("stops (and so releases) the recording when the encoder reports an error", () => {
    const { result } = renderHook(() => useLocalRecording([] as RoomParticipant[], "Standup"));
    act(() => result.current.start());
    expect(result.current.recording).toBe(true);

    act(() => rec.options!.onError(new Error("encoder died")));

    expect(result.current.recording).toBe(false);
    expect(rec.stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop a second time on unmount after an error", () => {
    const { result, unmount } = renderHook(() => useLocalRecording([] as RoomParticipant[], "Standup"));
    act(() => result.current.start());
    act(() => rec.options!.onError(new Error("encoder died")));
    unmount();
    expect(rec.stop).toHaveBeenCalledTimes(1);
  });

  it("still stops once on a normal stop()", async () => {
    const { result } = renderHook(() => useLocalRecording([] as RoomParticipant[], "Standup"));
    act(() => result.current.start());
    await act(() => result.current.stop());
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(result.current.recording).toBe(false);
  });
});
