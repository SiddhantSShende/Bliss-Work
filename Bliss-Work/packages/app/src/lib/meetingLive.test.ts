/**
 * What the client treats as live, and when it asks the server again.
 *
 * The server is the authority (messaging-svc derives an effective status from
 * the call's own lifecycle); the client only refuses to show as live or
 * upcoming a call the server reports as over, and revalidates when a call is
 * due to have ended. It never decides "over" from the local clock.
 */
import { describe, expect, it } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import { bucketFor, isCallOver } from "./meetingView";
import { nextLapseCheckMs } from "./useLapseRevalidation";

const base = {
  id: "00000000-0000-4000-8000-000000000801",
  orgId: "00000000-0000-4000-8000-000000000999",
  kind: "CHANNEL",
  title: "Sync",
  media: "video",
  createdBy: "00000000-0000-4000-8000-000000000001",
  scheduledAt: null,
  endsAt: null,
  startedAt: null,
  startedBy: null,
  endedAt: null,
  status: "LIVE",
  createdAt: "2026-09-29T09:00:00.000Z",
  participants: [],
  activeShares: [],
  channelIds: [],
} as CallDTO;
const call = (over: Partial<CallDTO>): CallDTO => ({ ...base, ...over });

describe("bucketFor — the Live list", () => {
  it("puts an active meeting in Live and a future one in Upcoming", () => {
    expect(bucketFor(call({ status: "LIVE" }))).toBe("live");
    expect(bucketFor(call({ status: "SCHEDULED" }))).toBe("upcoming");
  });

  it.each([
    ["explicitly ended", call({ status: "ENDED", endedAt: "2026-09-29T10:00:00.000Z" })],
    ["cancelled", call({ status: "CANCELLED" })],
    ["still LIVE, but carrying an endedAt", call({ status: "LIVE", endedAt: "2026-09-29T10:00:00.000Z" })],
    ["still SCHEDULED, but carrying an endedAt", call({ status: "SCHEDULED", endedAt: "2026-09-29T10:00:00.000Z" })],
  ])("never lists a meeting that is %s as live or upcoming", (_n, c) => {
    expect(isCallOver(c)).toBe(true);
    expect(bucketFor(c)).toBe("past");
  });

  it("does not decide from the local clock: an endsAt in the past on a call the server says is LIVE stays live", () => {
    const c = call({ status: "LIVE", endsAt: "2000-01-01T00:00:00.000Z" });
    expect(isCallOver(c)).toBe(false);
    expect(bucketFor(c)).toBe("live");
  });
});

describe("nextLapseCheckMs — when to ask the server again", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("waits for the nearest scheduled end, plus a beat", () => {
    const calls = [call({ endsAt: at(10 * 60_000) }), call({ endsAt: at(2 * 60_000) })];
    expect(nextLapseCheckMs(calls, now)).toBe(2 * 60_000 + 1_000);
  });

  it("re-asks at the sweeper's pace — not in a loop — when the server still reports an overdue call open", () => {
    expect(nextLapseCheckMs([call({ endsAt: at(-5 * 60_000) })], now)).toBe(30_000);
  });

  it("ignores calls that are over, or have no end", () => {
    const calls = [
      call({ status: "ENDED", endedAt: at(-1_000), endsAt: at(60_000) }),
      call({ endsAt: null }),
    ];
    expect(nextLapseCheckMs(calls, now)).toBeNull();
    expect(nextLapseCheckMs([], now)).toBeNull();
  });
});
