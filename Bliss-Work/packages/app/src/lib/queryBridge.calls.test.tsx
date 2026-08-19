/**
 * What the socket bridge does with the call lifecycle.
 *
 * The bug this file exists to prevent shipped once already: `call.started` was
 * emitted by the server, routed by the gateway, defined in the shared types and
 * received by the browser — and then dropped on the floor here, because the
 * switch had no case for it. Nothing failed. The Meetings list simply went on
 * showing a live meeting under "Upcoming", and its Join button went on asking
 * the server to START a call that was already running, which is a 403 for
 * everyone who is not entitled to open it.
 *
 * So these assert the invalidations, not the rendering: an event that changes
 * what the server would now return has to invalidate the query that asked.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventType, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { WsEventBridge, qk } from "./queryBridge";
import { INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";

const ws = vi.hoisted(() => ({
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
}));
const toasts = vi.hoisted(() => ({ shown: [] as string[] }));

vi.mock("sonner", () => {
  const toast = Object.assign(
    (msg: string) => {
      toasts.shown.push(msg);
    },
    {
      info: (m: string) => toasts.shown.push(m),
      error: (m: string) => toasts.shown.push(m),
      success: (m: string) => toasts.shown.push(m),
    },
  );
  return { toast };
});

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: {},
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      on: (cb: (e: unknown, meta?: WsEventMeta) => void) => {
        ws.emit = cb;
        return () => {};
      },
    },
  }),
}));

const ME = "11111111-1111-1111-1111-111111111111";
const HOST = "22222222-2222-2222-2222-222222222222";
const CALL = "33333333-3333-3333-3333-333333333333";
const CHANNEL = "44444444-4444-4444-4444-444444444444";

vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) =>
      sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[][] = [];
  const real = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    if (filters?.queryKey) invalidated.push(filters.queryKey);
    return real(filters as never);
  }) as typeof qc.invalidateQueries;

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WsEventBridge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    invalidated,
    /**
     * Deliver an event and let the bridge settle.
     *
     * Invalidations are COALESCED (lib/coalesceInvalidations): a burst of events
     * touching one list costs a single refetch instead of one per event, which
     * is what stopped the Meetings page firing ~30 concurrent /calls requests on
     * a socket replay. The bridge's contract is that the list gets refreshed,
     * not that it happens in the same tick, so the window is advanced here and
     * every assertion below reads as it always did.
     */
    fire: (e: ServerEvent, meta?: WsEventMeta) =>
      act(() => {
        ws.emit?.(e, meta);
        vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
      }),
    /** Deliver several events WITHOUT settling between them — a replay burst. */
    fireBurst: (events: ServerEvent[]) =>
      act(() => {
        for (const e of events) ws.emit?.(e);
        vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
      }),
  };
}

/** A call lifecycle event as the gateway delivers it. */
function callEvent(type: ServerEvent["type"], over: Record<string, unknown> = {}): ServerEvent {
  return {
    type,
    eventId: "55555555-5555-5555-5555-555555555555",
    occurredAt: new Date().toISOString(),
    orgId: "66666666-6666-6666-6666-666666666666",
    callId: CALL,
    kind: "MEETING",
    actorId: HOST,
    title: "Weekly review",
    ...over,
  } as ServerEvent;
}

const has = (keys: unknown[][], key: readonly unknown[]) =>
  keys.some((k) => JSON.stringify(k) === JSON.stringify(key));

beforeEach(() => {
  toasts.shown = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WsEventBridge — call event bursts", () => {
  // The bug this pins, seen in a browser network tab on /app/meetings: ~30
  // concurrent requests to /calls, all 200, queueing 179ms -> 750ms.
  //
  // The gateway REPLAYS buffered events when the socket connects, and each call
  // event invalidated up to four keys, so one replay burst fanned out into
  // dozens of refetches of the same list.
  const countOf = (keys: unknown[][], key: readonly unknown[]) =>
    keys.filter((k) => JSON.stringify(k) === JSON.stringify(key)).length;

  it("refetches the call list ONCE for a burst of call events", () => {
    const h = harness();
    h.fireBurst(
      Array.from({ length: 12 }, () => callEvent(EventType.CallStarted)),
    );
    expect(countOf(h.invalidated, qk.calls)).toBe(1);
  });

  it("still refetches once when the burst mixes different call events", () => {
    const h = harness();
    h.fireBurst([
      callEvent(EventType.CallStarted),
      callEvent(EventType.CallEnded),
      callEvent(EventType.CallRing),
      callEvent(EventType.CallScheduled),
      callEvent(EventType.CallStarted),
    ]);
    expect(countOf(h.invalidated, qk.calls)).toBe(1);
  });

  it("does not LOSE any distinct key in the burst", () => {
    // Collapsing repeats must never mean dropping a key nothing else refreshes.
    const h = harness();
    h.fireBurst([
      callEvent(EventType.CallStarted, { kind: "CHANNEL", channelId: CHANNEL }),
      callEvent(EventType.CallStarted),
    ]);
    expect(has(h.invalidated, qk.calls)).toBe(true);
    expect(has(h.invalidated, qk.call(CALL))).toBe(true);
    expect(has(h.invalidated, qk.channelCalls(CHANNEL))).toBe(true);
  });

  it("refetches again for a LATER burst, rather than going quiet", () => {
    // The window must not be re-armed indefinitely by a steady event stream.
    const h = harness();
    h.fireBurst([callEvent(EventType.CallStarted)]);
    h.fireBurst([callEvent(EventType.CallStarted)]);
    expect(countOf(h.invalidated, qk.calls)).toBe(2);
  });
});

describe("WsEventBridge — calls", () => {
  it("refreshes the call list when a host opens a call", () => {
    const h = harness();
    h.fire(callEvent(EventType.CallStarted));
    expect(has(h.invalidated, qk.calls)).toBe(true);
    expect(has(h.invalidated, qk.call(CALL))).toBe(true);
  });

  it("also refreshes the channel's own call list for a channel call", () => {
    const h = harness();
    h.fire(callEvent(EventType.CallStarted, { kind: "CHANNEL", channelId: CHANNEL }));
    expect(has(h.invalidated, qk.channelCalls(CHANNEL))).toBe(true);
  });

  it("announces a start somebody else made, with a way to get there", () => {
    const h = harness();
    h.fire(callEvent(EventType.CallStarted));
    expect(toasts.shown).toContain("Weekly review has started");
  });

  it("does not announce my own start", () => {
    const h = harness();
    h.fire(callEvent(EventType.CallStarted, { actorId: ME }));
    expect(toasts.shown).toHaveLength(0);
    // …but still refreshes: my other tabs are looking at the same stale row.
    expect(has(h.invalidated, qk.calls)).toBe(true);
  });

  it("never announces a start replayed on reconnect", () => {
    // The gateway replays up to 200 events per connect. A meeting that started
    // — and finished — this morning must not ring on every launch.
    const h = harness();
    h.fire(callEvent(EventType.CallStarted), { replayed: true });
    expect(toasts.shown).toHaveLength(0);
    expect(has(h.invalidated, qk.calls)).toBe(true);
  });

  it("tells whoever can open a call that somebody is waiting on it", () => {
    // Addressed by the SERVER to the people who could start it and nobody else,
    // which is why there is no recipient check here.
    const h = harness();
    h.fire(callEvent(EventType.CallWaiting));
    expect(toasts.shown).toContain("Someone is waiting for Weekly review");
  });

  it("does not replay a stale 'someone is waiting'", () => {
    const h = harness();
    h.fire(callEvent(EventType.CallWaiting), { replayed: true });
    expect(toasts.shown).toHaveLength(0);
  });

  // One harness per event: the runtime mock hands out a single subscription
  // slot, so a second render would steal the first's emitter.
  it.each([
    EventType.CallScheduled,
    EventType.CallParticipantAdded,
    EventType.CallEnded,
    EventType.CallRing,
  ])("keeps refreshing the call list on %s", (type) => {
    const h = harness();
    h.fire(callEvent(type));
    expect(has(h.invalidated, qk.calls)).toBe(true);
  });

  it.each([EventType.CallShareStarted, EventType.CallShareStopped])(
    "refreshes the call itself on %s",
    (type) => {
      const h = harness();
      h.fire(callEvent(type, { shareSource: "SCREEN" }));
      expect(has(h.invalidated, qk.call(CALL))).toBe(true);
    },
  );
});
