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
    // Enough for the pending reconnect timer (armed by the earlier
    // empty-token attempt) to fire and dial with the now-live token — well
    // under CONNECT_TIMEOUT_MS, so the new socket isn't force-closed before
    // its handshake below completes.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.latest().url).toContain(`token=${encodeURIComponent(token)}`);
    FakeWS.latest().accept();
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

  it("gives up on a handshake that hangs instead of getting stuck CONNECTING forever", async () => {
    // Neither onopen, onclose nor onerror ever fires here — simulating a proxy
    // or dead network path that silently swallows the WS upgrade rather than
    // refusing it. Without a connect-attempt timeout, connect()'s own
    // idempotency guard (readyState 0 or 1 -> no-op) makes every later
    // token-forward do nothing forever, and the client never recovers.
    const token = liveToken();
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken: () => token,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.latest().readyState).toBe(0); // still CONNECTING

    // A later token-forward while stuck would otherwise be a silent no-op.
    await vi.advanceTimersByTimeAsync(15_000);

    // The timeout force-closed the hung socket, which drove the ordinary
    // onclose -> scheduleReconnect() path — a fresh socket was dialed.
    expect(FakeWS.instances).toHaveLength(2);
  });

  it("never lets a stale reconnect timer open a second socket after a close()/connect() cycle", async () => {
    // Sequence that used to orphan a socket (see apps/desktop/src/main/ws-process.ts,
    // which runs exactly this close()-then-connect() cycle on sign-out/sign-in
    // on the same long-lived WsClient):
    //   1. A network blip drops the socket -> onclose arms a reconnect timer.
    //   2. Something calls close() (e.g. sign-out) BEFORE that timer fires.
    //   3. Something calls connect() again (e.g. sign-in) -> a fresh socket opens.
    //   4. The stale timer from step 1 finally fires.
    // Without tracking the timer handle, close() couldn't cancel it, and
    // without the reconnect path sharing connect()'s idempotency guard, step 4
    // dialed a THIRD socket on top of the one from step 3 — messages then only
    // arrive on whichever socket the server/client happens to route them to.
    const ws = new WsClient({
      url: "ws://x/ws",
      getToken: () => liveToken(),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    await ws.connect();
    const first = FakeWS.latest();
    first.accept();

    // 1. Network blip: the remote end drops the socket, arming the backoff timer.
    first.close();
    expect(FakeWS.instances).toHaveLength(1);

    // 2. Deliberate close (e.g. sign-out) before the backoff timer fires.
    ws.close();

    // 3. Sign back in on the same instance: a fresh socket opens.
    await ws.connect();
    expect(FakeWS.instances).toHaveLength(2);
    const second = FakeWS.latest();
    expect(second).not.toBe(first);
    second.accept();

    // 4. Let the stale timer's backoff window (and then some) fully elapse.
    await vi.advanceTimersByTimeAsync(10_000);

    // No third, orphaning socket — the stale timer either got cancelled by
    // close() or found `second` already live and declined to dial again.
    expect(FakeWS.instances).toHaveLength(2);
  });
});
