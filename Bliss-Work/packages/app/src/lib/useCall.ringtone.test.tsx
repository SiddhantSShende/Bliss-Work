/**
 * The wiring between "a call.invite arrived" and "sound comes out".
 *
 * ringtone.test.ts covers the tone generator in isolation; this covers the
 * thing that actually failed in production — whether CallProvider ever asks it
 * to play, and whether it stops when the ring ends.
 */
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ControlFrame } from "@taskboard/shared";
import { CallProvider } from "./useCall";

const started: string[] = [];
const stopped: string[] = [];

vi.mock("./ringtone", () => ({
  createRingtone: (kind: string) => ({
    start: () => started.push(kind),
    stop: () => stopped.push(kind),
  }),
  primeRingtoneAudio: () => () => {},
}));

// The rtc transport CallProvider subscribes to, captured so tests can push
// control frames the way ws-gateway would.
const rtc = vi.hoisted(() => ({ emit: undefined as ((f: unknown) => void) | undefined }));
const sent = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("./callNotify", () => ({
  primeCallNotifications: () => () => {},
  notifyIncomingCall: () => ({ close: () => {} }),
  notifyMissedCall: () => {},
}));

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    api: {
      directory: () => Promise.resolve([]),
      turnCredentials: () => Promise.resolve({ iceServers: [] }),
      sendMessage: (...args: unknown[]) => {
        sent.calls.push(args);
        return Promise.resolve({ conversationId: "c", threadId: "t", messageId: "m", seq: 1 });
      },
    },
    rtc: {
      sendFrame: () => {},
      onControl: (cb: (f: unknown) => void) => {
        rtc.emit = cb;
        return () => {};
      },
    },
    rtcAvailable: true,
  }),
}));

function harness() {
  const ui = (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CallProvider>
        <div />
      </CallProvider>
    </QueryClientProvider>
  );
  return { ui, fire: (f: ControlFrame) => act(() => rtc.emit?.(f)) };
}

const FROM = "11111111-1111-1111-1111-111111111111";
const CALL_ID = "22222222-2222-2222-2222-222222222222";

const INVITE = {
  type: "call.invite",
  fromUserId: FROM,
  callId: CALL_ID,
  media: "audio",
  fromName: "alice",
} as unknown as ControlFrame;

describe("CallProvider ringing", () => {
  beforeEach(() => {
    started.length = 0;
    stopped.length = 0;
    sent.calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("rings on an incoming invite", () => {
    const { ui, fire } = harness();
    render(ui);

    fire(INVITE);

    expect(started).toEqual(["incoming"]);
  });

  it("stops ringing when the caller cancels", () => {
    const { ui, fire } = harness();
    render(ui);

    fire(INVITE);
    fire({ type: "call.cancel", fromUserId: FROM, callId: CALL_ID } as unknown as ControlFrame);

    expect(stopped).toEqual(["incoming"]);
  });

  // The callee must NOT also write one, or every unanswered call lands in the
  // thread twice.
  it("does not record a missed call on the receiving side", () => {
    const { ui, fire } = harness();
    render(ui);

    fire(INVITE);
    fire({ type: "call.cancel", fromUserId: FROM, callId: CALL_ID } as unknown as ControlFrame);

    expect(sent.calls).toHaveLength(0);
  });
});
