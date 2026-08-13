import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WsClient } from "./WsClient";

/**
 * Guards the connect-time catch-up burst against being announced as news.
 *
 * ws-gateway replays up to 200 buffered events on every `hello` (store.Replay
 * with lastSeenSeq <= 0), and the client's dedup LRU is per-instance memory, so
 * a reload or relaunch starts empty and every one of those events runs the full
 * handler chain again. That is what produced "all my notifications come back
 * every time I reopen the app", plus a desktop that re-pinned notes the user
 * had already cleared.
 *
 * The contract pinned here: everything between `hello` and the gateway's
 * `replay.done` is flagged `replayed`, everything after it is not, and a
 * reconnect asks only for what it missed.
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
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Deliver one frame exactly as the gateway would. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  static latest(): FakeWS {
    const ws = FakeWS.instances.at(-1);
    if (!ws) throw new Error("expected a socket to have been constructed");
    return ws;
  }
}

function liveToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .toString("base64url");
  return `header.${payload}.sig`;
}

/** A minimal valid MessageCreated, which is what the outbox mostly holds. */
function messageCreated(nth: number, occurredAt: string) {
  // uuidv7-shaped: the final group must be exactly 12 hex characters or the
  // zod envelope rejects the frame and the client drops it before any handler.
  const id = (tag: string) => `018f0000-0000-7000-8000-0000${tag}${String(nth).padStart(6, "0")}`;
  return {
    type: "message.created",
    eventId: id("ee"),
    orgId: "018f0000-0000-7000-8000-0000000000f0",
    occurredAt,
    conversationId: "018f0000-0000-7000-8000-0000000000c1",
    messageId: id("dd"),
    seq: nth,
    senderId: "018f0000-0000-7000-8000-0000000000a1",
    recipientId: "018f0000-0000-7000-8000-0000000000a2",
    body: "hello",
    clientMsgId: id("cc"),
  };
}

function newClient() {
  return new WsClient({
    url: "wss://example.test/ws",
    getToken: () => liveToken(),
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
  });
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WsClient catch-up replay", () => {
  it("flags events delivered before replay.done, and not those after", async () => {
    const seen: { id: string; replayed: boolean }[] = [];
    const client = newClient();
    client.on((e, meta) => seen.push({ id: e.eventId, replayed: meta.replayed }));

    await client.connect();
    const ws = FakeWS.latest();
    ws.accept();

    // The burst: ready, then the buffered history, then the marker.
    ws.deliver({ type: "ready", userId: "u", orgId: "o" });
    ws.deliver(messageCreated(1, "2026-08-13T10:00:00.000Z"));
    ws.deliver(messageCreated(2, "2026-08-13T10:00:01.000Z"));
    ws.deliver({ type: "replay.done" });
    // …and then something that genuinely just happened.
    ws.deliver(messageCreated(3, "2026-08-13T10:00:02.000Z"));

    expect(seen.map((s) => s.replayed)).toEqual([true, true, false]);
  });

  it("stops suppressing when the marker never arrives", async () => {
    // A gateway older than replay.done, or a lost frame, must not leave this
    // client silently swallowing every toast for the life of the connection —
    // that failure is far worse than the storm the marker prevents.
    const seen: boolean[] = [];
    const client = newClient();
    client.on((_e, meta) => seen.push(meta.replayed));

    await client.connect();
    const ws = FakeWS.latest();
    ws.accept();
    ws.deliver(messageCreated(4, "2026-08-13T10:00:00.000Z"));
    expect(seen).toEqual([true]);

    // No marker ever comes; the grace period expires and normal service resumes.
    await vi.advanceTimersByTimeAsync(11_000);
    ws.deliver(messageCreated(6, "2026-08-13T10:00:04.000Z"));

    expect(seen).toEqual([true, false]);
    client.close();
  });

  it("asks only for what it missed when it reconnects", async () => {
    const client = newClient();
    await client.connect();
    const first = FakeWS.latest();
    first.accept();
    first.deliver({ type: "replay.done" });
    first.deliver(messageCreated(5, "2026-08-13T10:00:03.000Z"));

    // First hello has no cursor: a fresh process wants the full catch-up.
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ type: "hello" });
    expect(JSON.parse(first.sent[0]!).lastSeenSeq).toBeUndefined();

    // Drop the socket and let the backoff fire.
    first.close();
    await vi.advanceTimersByTimeAsync(60_000);

    const second = FakeWS.latest();
    expect(second).not.toBe(first);
    second.accept();

    // The reconnect carries the newest occurredAt it saw, in epoch ms — the
    // exact score the gateway's replay ZSET is keyed by.
    const hello = JSON.parse(second.sent[0]!);
    expect(hello.lastSeenSeq).toBe(Date.parse("2026-08-13T10:00:03.000Z"));

    client.close();
  });
});
