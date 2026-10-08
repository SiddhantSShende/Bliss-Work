/**
 * What the socket bridge does with call.scheduled — and what it must NOT touch.
 *
 * call.scheduled used to raise a plain Sonner toast. It now raises the
 * ScheduledMeetingNotice card instead, so these mount the bridge AND the card
 * together and deliver real events: the assertion is "a card is on screen and no
 * toast was raised", not that some internal function was called.
 *
 * The guards on it (someone else's scheduling only, never a replay) and the
 * incoming-meeting events it shares a handler with are covered here too, since
 * that shared branch is where a regression would hide.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { ScheduledMeetingNotice } from "../features/ScheduledMeetingNotice";
import { INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";
import { WsEventBridge } from "./queryBridge";

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
    // Never settles: the card's host/end-time read is not what is under test
    // here, and a pending query keeps the file free of late state updates.
    api: { call: () => new Promise(() => {}) },
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      onStatus: () => () => {},
      on: (cb: (e: unknown, meta?: WsEventMeta) => void) => {
        ws.emit = cb;
        return () => {};
      },
    },
  }),
}));

const ME = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";
const CALL = "33333333-3333-4333-8333-333333333333";
const EVENT = "55555555-5555-4555-8555-555555555555";
const START = "2031-03-14T09:30:00.000Z";

vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) =>
      sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WsEventBridge />
        <ScheduledMeetingNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Deliver an event, then let the bridge's coalesced invalidation window pass. */
const fire = (e: ServerEvent, meta?: WsEventMeta) =>
  act(() => {
    ws.emit?.(e, meta);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
  });

function callEvent(type: ServerEvent["type"], over: Record<string, unknown> = {}): ServerEvent {
  return {
    type,
    eventId: EVENT,
    occurredAt: new Date().toISOString(),
    orgId: "66666666-6666-4666-8666-666666666666",
    callId: CALL,
    kind: "MEETING",
    actorId: HOST,
    title: "Weekly review",
    scheduledAt: START,
    ...over,
  } as ServerEvent;
}

const scheduledEvent = (over: Record<string, unknown> = {}) => callEvent(EventType.CallScheduled, over);
const card = () => screen.queryByRole("alertdialog", { name: /Meeting scheduled/ });

// The incoming-meeting popup's own window events, captured the way the popup
// itself listens, so the unchanged wiring is proven rather than mocked.
const incoming: string[] = [];
const dismissed: string[] = [];
const onIncoming = (event: Event) => {
  incoming.push((event as CustomEvent<{ callId: string }>).detail.callId);
};
const onDismissed = (event: Event) => {
  dismissed.push((event as CustomEvent<{ callId: string }>).detail.callId);
};

beforeEach(() => {
  toasts.shown = [];
  incoming.length = 0;
  dismissed.length = 0;
  window.addEventListener("taskboard:incoming-meeting", onIncoming);
  window.addEventListener("taskboard:dismiss-incoming-meeting", onDismissed);
  vi.useFakeTimers();
});

afterEach(() => {
  window.removeEventListener("taskboard:incoming-meeting", onIncoming);
  window.removeEventListener("taskboard:dismiss-incoming-meeting", onDismissed);
  vi.useRealTimers();
});

describe("WsEventBridge — call.scheduled", () => {
  it("raises the scheduled-meeting card, not a toast, for someone else's scheduling", () => {
    mount();
    fire(scheduledEvent());

    expect(screen.getByRole("alertdialog", { name: "Meeting scheduled: Weekly review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join Meeting" })).toBeInTheDocument();
    expect(toasts.shown).toEqual([]);
  });

  it("says nothing for a meeting I scheduled myself", () => {
    mount();
    fire(scheduledEvent({ actorId: ME }));

    expect(card()).toBeNull();
    expect(toasts.shown).toEqual([]);
  });

  it("says nothing for a scheduling replayed on reconnect", () => {
    mount();
    fire(scheduledEvent(), { replayed: true });

    expect(card()).toBeNull();
    expect(toasts.shown).toEqual([]);
  });

  it("raises one card when the same event is delivered twice", () => {
    mount();
    fire(scheduledEvent());
    fire(scheduledEvent());

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("falls back to a title rather than showing a blank one", () => {
    mount();
    fire(scheduledEvent({ title: undefined }));
    expect(screen.getByRole("alertdialog", { name: "Meeting scheduled: Meeting" })).toBeInTheDocument();
  });

  it("does not ring the incoming-meeting popup, or dismiss one", () => {
    mount();
    fire(scheduledEvent());

    expect(incoming).toEqual([]);
    expect(dismissed).toEqual([]);
  });
});

describe("WsEventBridge — incoming meetings are unaffected", () => {
  it.each([EventType.CallStarted, EventType.CallWaiting, EventType.CallRing])(
    "%s still announces the incoming-meeting popup, and raises no scheduled card",
    (type) => {
      mount();
      fire(callEvent(type));

      expect(incoming).toEqual([CALL]);
      expect(card()).toBeNull();
      expect(toasts.shown).toEqual([]);
    },
  );

  it.each([EventType.CallEnded, EventType.CallParticipantAdded])(
    "%s still dismisses an incoming-meeting popup",
    (type) => {
      mount();
      fire(callEvent(type));

      expect(dismissed).toEqual([CALL]);
      expect(card()).toBeNull();
    },
  );
});
