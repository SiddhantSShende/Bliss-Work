import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WsClient } from "./WsClient";

/**
 * Guards the reconnect loop against a session the server has ENDED.
 *
 * ws-gateway authenticates at the handshake and 401s a request with no token.
 * Once the rotating-refresh family is revoked ('reused'), refreshSession answers
 * null locally forever, so getToken() returns "" — and the old client happily
 * dialed `?token=` on a capped 30s backoff for as long as the tab stayed open.
 * Production logged 91 "empty token" rejections in 15 minutes from exactly this.
 *
 * The contract these tests pin down: a dead session parks (no socket, no timer),
 * an absent-but-recoverable token costs a timer but never a connection, and the
 * ordinary path is untouched.
 */

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Drive the handshake to completion the way a real socket would. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The socket most recently constructed; throws rather than returning
   *  undefined so a test asserting on "the" socket can't silently pass. */
  static latest(): FakeWS {
    const ws = FakeWS.instances.at(-1);
    if (!ws) throw new Error("expected a socket to have been constructed");
    return ws;
  }
}

/** A JWT whose exp is well in the future, so isExpiredJwt() leaves it alone. */
function liveToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .toString("base64url");
  return `header.${payload}.sig`;
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WsClient reconnect gating", () => {
  it("does not dial at all when the session is already dead", async () => {
    const getToken = vi.fn(() => "");
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken,
      isDead: () => true,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();

    expect(FakeWS.instances).toHaveLength(0);
    // Parked before it even asked for a token.
    expect(getToken).not.toHaveBeenCalled();
  });

  it("stops reconnecting once the session dies mid-flight", async () => {
    let dead = false;
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken: () => liveToken(),
      isDead: () => dead,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();
    expect(FakeWS.instances).toHaveLength(1);
    FakeWS.latest().accept();

    // The family is revoked while we're connected; the socket drops.
    dead = true;
    FakeWS.latest().close();

    // Old behaviour: a new socket every <=30s, forever.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("never dials on an empty token, but stays retryable", async () => {
    const getToken = vi.fn(() => "");
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken,
      // Refresh can't produce one yet (session still loading) — NOT terminal.
      refreshToken: async () => "",
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();
    expect(FakeWS.instances).toHaveLength(0);

    const callsBefore = getToken.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // Still no wasted connection to the gateway...
    expect(FakeWS.instances).toHaveLength(0);
    // ...but it kept trying, so a late login recovers.
    expect(getToken.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("recovers once a token arrives", async () => {
    let token = "";
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken: () => token,
      refreshToken: async () => token,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();
    expect(FakeWS.instances).toHaveLength(0);

    token = liveToken();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.latest().url).toContain(`token=${encodeURIComponent(token)}`);
  });

  it("connects normally when there is no isDead signal at all", async () => {
    const token = liveToken();
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken: () => token,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();

    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.latest().url).toBe(`ws://x/ws?token=${encodeURIComponent(token)}`);
  });
});
