import { describe, expect, it } from "vitest";
import { createRefreshGate } from "./sticky-refresh";

/**
 * Every task.* event starts its own /tasks/sticky read, so several are in flight
 * at once and answer in any order. Only the newest may publish (an older answer
 * landing late would put back a task the newer list dropped) — but an older read
 * that succeeded must not be thrown away if the newest one then fails.
 */
describe("createRefreshGate", () => {
  it("publishes the newest read and drops an older one that lands after it", () => {
    const gate = createRefreshGate<string>();
    const older = gate.begin();
    const newest = gate.begin();

    expect(gate.succeeded(newest, "newest")).toBe(true);
    expect(gate.succeeded(older, "older")).toBe(false);
  });

  it("does not publish an older read that finishes first; the newest still does", () => {
    const gate = createRefreshGate<string>();
    const older = gate.begin();
    const newest = gate.begin();

    expect(gate.succeeded(older, "older")).toBe(false);
    expect(gate.succeeded(newest, "newest")).toBe(true);
  });

  it("publishes the older read that succeeded when the newest gives up", () => {
    const gate = createRefreshGate<string>();
    const older = gate.begin();
    const newest = gate.begin();

    gate.succeeded(older, "older");

    expect(gate.gaveUp(newest)).toBe("older");
  });

  it("falls back to the freshest of several superseded reads", () => {
    const gate = createRefreshGate<string>();
    const first = gate.begin();
    const second = gate.begin();
    const newest = gate.begin();

    gate.succeeded(second, "second");
    gate.succeeded(first, "first"); // arrives later but is older: must not replace the spare

    expect(gate.gaveUp(newest)).toBe("second");
  });

  it("never falls back to a read older than one already published", () => {
    const gate = createRefreshGate<string>();
    const stale = gate.begin();
    const published = gate.begin();
    gate.succeeded(published, "published");
    const later = gate.begin();

    gate.succeeded(stale, "stale"); // lands after `published` went out

    expect(gate.gaveUp(later)).toBeUndefined();
  });

  it("does not resurrect a spare once the newest read has published", () => {
    const gate = createRefreshGate<string>();
    const older = gate.begin();
    const newest = gate.begin();
    gate.succeeded(older, "older");
    gate.succeeded(newest, "newest");
    const next = gate.begin();

    expect(gate.gaveUp(next)).toBeUndefined();
  });

  it("gives nothing back when the newest gives up and no older read succeeded", () => {
    const gate = createRefreshGate<string>();

    expect(gate.gaveUp(gate.begin())).toBeUndefined();
  });

  it("only lets the newest read give up on the spare; a superseded one publishes nothing", () => {
    const gate = createRefreshGate<string>();
    const superseded = gate.begin();
    const older = gate.begin();
    const newest = gate.begin();
    gate.succeeded(older, "older");

    expect(gate.gaveUp(superseded)).toBeUndefined();
    expect(gate.gaveUp(newest)).toBe("older"); // the spare was left intact
  });

  it("drops everything in flight on sign-out, and never lets it back in for the next user", () => {
    const gate = createRefreshGate<string>();
    const inFlight = gate.begin();
    const kept = gate.begin();
    gate.succeeded(inFlight, "previous user's read");
    gate.cancel();

    expect(gate.succeeded(kept, "previous user's other read")).toBe(false);
    const afterSignIn = gate.begin();
    expect(gate.gaveUp(afterSignIn)).toBeUndefined();
  });

  it("marks only the newest ticket current", () => {
    const gate = createRefreshGate<string>();
    const older = gate.begin();
    const newest = gate.begin();

    expect([gate.isCurrent(older), gate.isCurrent(newest)]).toEqual([false, true]);
    gate.cancel();
    expect(gate.isCurrent(newest)).toBe(false);
  });
});
