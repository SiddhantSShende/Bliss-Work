import { describe, expect, it } from "vitest";
import { resolveStatus } from "./usePresence";

/**
 * A person's status is presence AND call state, resolved in that order.
 *
 * "Busy" is the whole point: being connected and being interruptible are
 * different questions, and answering the second with the first is worse than
 * saying nothing — a colleague acts on it. They ring someone who is mid-meeting,
 * or allocate work to someone who cannot look at it.
 */
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

describe("resolveStatus", () => {
  it("reports someone in a call as busy, not online", () => {
    const status = resolveStatus(new Set([ALICE, BOB]), new Set([ALICE]));
    expect(status(ALICE)).toBe("busy");
    // Being online is not enough to be shown as available.
    expect(status(BOB)).toBe("online");
  });

  it("reports busy even when the presence set has not caught up", () => {
    // Someone in a call is by definition connected, but their presence entry
    // may be a beat from being reaped. "Busy" is still true; "Offline" is not.
    const status = resolveStatus(new Set(), new Set([CAROL]));
    expect(status(CAROL)).toBe("busy");
  });

  it("reports everyone else as offline", () => {
    const status = resolveStatus(new Set([BOB]), new Set([ALICE]));
    expect(status(CAROL)).toBe("offline");
  });

  it("is offline when nothing is known at all", () => {
    const status = resolveStatus(new Set(), new Set());
    expect(status(ALICE)).toBe("offline");
  });
});
