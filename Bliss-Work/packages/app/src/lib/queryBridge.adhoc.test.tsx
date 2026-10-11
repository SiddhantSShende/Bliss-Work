/**
 * Being added to an ad-hoc call (a 1:1 that grew into a conference) rings as a
 * CALL, not a meeting.
 *
 * Mounts the socket bridge AND the incoming-call card together and delivers
 * real events, so the assertion is what is on screen. The other half of the
 * bug — the added person landing in the Meetings lifecycle — is the next tests
 * down: no resume offer, no Meetings redirect.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { IncomingMeetingNotice } from "../features/IncomingMeetingNotice";
import { INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";
import { WsEventBridge } from "./queryBridge";

const ws = vi.hoisted(() => ({
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }),
}));

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: {},
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
const ADDER = "22222222-2222-4222-8222-222222222222";
const CALL = "33333333-3333-4333-8333-333333333333";

vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) => sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WsEventBridge />
        <IncomingMeetingNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fire = (e: ServerEvent) =>
  act(() => {
    ws.emit?.(e);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
  });

function callEvent(type: ServerEvent["type"], over: Record<string, unknown> = {}): ServerEvent {
  return {
    type,
    eventId: "55555555-5555-4555-8555-555555555555",
    occurredAt: new Date().toISOString(),
    orgId: "66666666-6666-4666-8666-666666666666",
    callId: CALL,
    kind: "DIRECT",
    actorId: ADDER,
    actorName: "Jordan Doe",
    ...over,
  } as ServerEvent;
}

const dismissed: string[] = [];
const onDismissed = (event: Event) => {
  dismissed.push((event as CustomEvent<{ callId: string }>).detail.callId);
};

beforeEach(() => {
  dismissed.length = 0;
  window.addEventListener("taskboard:dismiss-incoming-meeting", onDismissed);
  vi.useFakeTimers();
});
afterEach(() => {
  window.removeEventListener("taskboard:dismiss-incoming-meeting", onDismissed);
  vi.useRealTimers();
});

describe("a ring into an ad-hoc call", () => {
  it("is an incoming CALL from the person who added you, with no meeting wording", () => {
    mount();
    fire(callEvent(EventType.CallRing));

    const card = screen.getByRole("alertdialog", { name: "Incoming call: Jordan Doe added you to a conference call" });
    expect(card).toHaveTextContent("Jordan Doe added you to a conference call");
    expect(card.textContent).not.toMatch(/meeting|hosted by/i);
    // The same ways in as any incoming call.
    expect(screen.getByRole("button", { name: "Join with camera on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join with voice only" })).toBeInTheDocument();
  });

  it("still reads as a call when the server could not name who added you", () => {
    mount();
    fire(callEvent(EventType.CallRing, { actorName: undefined }));

    expect(screen.getByRole("alertdialog", { name: "Incoming call: Conference call" })).toBeInTheDocument();
  });

  it("is not taken down by the participant_added that follows it to the whole room", () => {
    mount();
    fire(callEvent(EventType.CallRing));
    fire(callEvent(EventType.CallParticipantAdded));

    expect(dismissed).toEqual([]);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("goes away when the call ends", () => {
    mount();
    fire(callEvent(EventType.CallRing));
    fire(callEvent(EventType.CallEnded));

    expect(dismissed).toEqual([CALL]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("a ring into a MEETING keeps its meeting wording", () => {
  it("is an incoming meeting, titled as before", () => {
    mount();
    fire(callEvent(EventType.CallRing, { kind: "MEETING", title: "Weekly review", actorName: "Jordan Doe" }));

    expect(screen.getByRole("alertdialog", { name: "Incoming meeting: Weekly review" })).toBeInTheDocument();
  });

  it("a scheduled DIRECT call is not ad-hoc either", () => {
    mount();
    fire(callEvent(EventType.CallRing, { title: "Sync", scheduledAt: "2031-03-14T09:30:00.000Z" }));

    expect(screen.getByRole("alertdialog", { name: "Incoming meeting: Sync" })).toBeInTheDocument();
  });

  it("participant_added still withdraws the card", () => {
    mount();
    fire(callEvent(EventType.CallRing, { kind: "MEETING", title: "Weekly review" }));
    fire(callEvent(EventType.CallParticipantAdded, { kind: "MEETING", title: "Weekly review" }));

    expect(dismissed).toEqual([CALL]);
  });
});
