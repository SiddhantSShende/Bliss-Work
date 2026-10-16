/**
 * The ring-resolution events a 1:1 ad-hoc call's caller/invitee can receive
 * once the server resolves a ring one way or another:
 *
 *  - call.declined / call.no_answer — realtime-only, addressed to the
 *    INVITER. Told to CallRoom via MeetingSession.announceCallResolution
 *    (see queryBridge's handleCallEvent), and — defensively — also clear any
 *    IncomingMeetingNotice card still open for that callId.
 *  - call.missed — the durable counterpart, addressed to the INVITEE. No
 *    resolution is announced (there is nothing for a caller's room to react
 *    to), but a card still open for it is cleared the same way.
 *
 * Mounts the real socket bridge and delivers real events, the same shape as
 * queryBridge.adhoc.test.tsx — the assertion is what actually happened
 * (the window event fired, the card went away), not that some internal
 * function was called.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { IncomingMeetingNotice } from "../features/IncomingMeetingNotice";
import { onCallResolutionAnnounced } from "./MeetingSession";
import { INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";
import { WsEventBridge } from "./queryBridge";

const ws = vi.hoisted(() => ({
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
}));
const h = vi.hoisted(() => ({
  declineCall: vi.fn(async () => {}),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { info: () => {}, error: h.toastError, success: () => {} }),
}));

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: {},
    api: { call: () => new Promise(() => {}), declineCall: h.declineCall },
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
const PEER = "22222222-2222-4222-8222-222222222222";
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
    actorId: PEER,
    actorName: "Jordan Doe",
    ...over,
  } as ServerEvent;
}

beforeEach(() => {
  h.declineCall.mockReset().mockResolvedValue(undefined);
  h.toastError.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("call.declined / call.no_answer", () => {
  it("announces a resolution for the caller's room to react to", () => {
    const resolutions: Array<[string, unknown]> = [];
    const off = onCallResolutionAnnounced((callId, r) => resolutions.push([callId, r]));
    mount();

    fire(callEvent(EventType.CallDeclined, { actorName: "Jordan Doe" }));

    expect(resolutions).toEqual([[CALL, { reason: "declined", actorName: "Jordan Doe" }]]);
    off();
  });

  it("no_answer announces its own distinct reason", () => {
    const resolutions: Array<[string, unknown]> = [];
    const off = onCallResolutionAnnounced((callId, r) => resolutions.push([callId, r]));
    mount();

    fire(callEvent(EventType.CallNoAnswer, { actorName: "Jordan Doe" }));

    expect(resolutions).toEqual([[CALL, { reason: "no_answer", actorName: "Jordan Doe" }]]);
    off();
  });

  it("also clears an IncomingMeetingNotice card still open for this call", () => {
    mount();
    fire(callEvent(EventType.CallRing));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fire(callEvent(EventType.CallDeclined));

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("call.missed", () => {
  it("clears a card still open for this call, same as call.ended", () => {
    mount();
    fire(callEvent(EventType.CallRing));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fire(callEvent(EventType.CallMissed));

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("IncomingMeetingNotice — Decline (ad-hoc ring only)", () => {
  it("calls api.declineCall and dismisses the card", () => {
    mount();
    fire(callEvent(EventType.CallRing));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(h.declineCall).toHaveBeenCalledWith(CALL);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("surfaces a failed decline request after dismissing the card", async () => {
    h.declineCall.mockRejectedValueOnce(new Error("network unavailable"));
    mount();
    fire(callEvent(EventType.CallRing));

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await vi.waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("Couldn't decline the call. Please try again."),
    );
  });

  it("a genuine meeting invite keeps its plain Leave, not Decline", () => {
    mount();
    fire(callEvent(EventType.CallRing, { kind: "MEETING", title: "Weekly review" }));

    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    // Its accessible name is "Dismiss" (the aria-label/title) even though the
    // visible caption underneath reads "Leave" — see NoticeAction.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByText("Leave")).toBeInTheDocument();
  });
});
