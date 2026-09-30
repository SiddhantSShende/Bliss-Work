/**
 * Focused coverage for the meeting timer's own tick/format logic — the one
 * piece CallRoom.tsx explicitly reuses rather than reimplementing (see its
 * own `meetingDuration` comment). Untouched by the stale-CallDTO fix; this
 * locks down the ticking/formatting behaviour that fix depends on: elapsed
 * time is read from the given `startedAt`, never from when the hook itself
 * happened to mount.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallDuration } from "./callTimer";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useCallDuration", () => {
  it("is empty until there is a startedAt to count from", () => {
    const { result } = renderHook(() => useCallDuration(undefined));
    expect(result.current).toBe("");
  });

  it("reads elapsed time from startedAt, not from when the hook itself mounted", () => {
    const startedAt = Date.now() - 65_000; // the meeting began 65s before this client mounted
    const { result } = renderHook(() => useCallDuration(startedAt));
    expect(result.current).toBe("1:05");
  });

  it("ticks forward once a second while mounted", () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useCallDuration(startedAt));
    expect(result.current).toBe("0:00");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe("0:03");
  });

  it("switches to h:mm:ss once the call passes an hour", () => {
    const startedAt = Date.now() - (60 * 60 + 61) * 1000; // 1h01m01s ago
    const { result } = renderHook(() => useCallDuration(startedAt));
    expect(result.current).toBe("1:01:01");
  });
});
