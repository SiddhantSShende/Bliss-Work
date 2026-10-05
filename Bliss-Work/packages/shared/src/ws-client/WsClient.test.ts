/**
 * close() followed straight away by connect() is how the client changes
 * membership (an org switch) and how a signed-out client is revived. A real
 * socket finishes closing LATER, so the old socket's `onclose` lands after the
 * new socket is already up — and it used to act on the client's shared state:
 * report "closed", stop the NEW socket's heartbeat, and queue a reconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, type WsStatus } from "./WsClient";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (ev: { data: string }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Like a real socket, closing starts a handshake; `onclose` fires when it ends. */
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  finishClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const pings = (s: FakeSocket) => s.sent.filter((f) => f.includes('"ping"')).length;

function makeClient() {
  const client = new WsClient({
    url: "wss://gateway.test/ws",
    getToken: async () => "token",
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  const statuses: WsStatus[] = [];
  client.onStatus((s) => statuses.push(s));
  return { client, statuses };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("WsClient socket replacement", () => {
  it("does not send frames or pings unless the current socket is open", async () => {
    const { client } = makeClient();
    await client.connect();
    const socket = FakeSocket.instances[0]!;
    const frame = { type: "typing", toUserId: "peer", conversationId: "conversation", state: "start" } as const;

    client.sendFrame(frame);
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1); // hello
    socket.readyState = 2;
    client.sendFrame(frame);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(socket.sent).toHaveLength(1);
  });

  it("keeps message acknowledgements queued until a replacement socket opens", async () => {
    const { client } = makeClient();
    await client.connect();
    const oldSocket = FakeSocket.instances[0]!;
    oldSocket.open();
    oldSocket.onmessage?.({
      data: JSON.stringify({
        type: "message.created",
        eventId: "00000000-0000-4000-8000-000000000001",
        orgId: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-09-30T09:00:00.000Z",
        conversationId: "00000000-0000-4000-8000-000000000003",
        messageId: "00000000-0000-4000-8000-000000000004",
        seq: 1,
        senderId: "00000000-0000-4000-8000-000000000005",
        recipientId: "00000000-0000-4000-8000-000000000006",
        body: "hello",
        clientMsgId: "00000000-0000-4000-8000-000000000007",
      }),
    });

    oldSocket.readyState = 2;
    await vi.advanceTimersByTimeAsync(500);
    expect(oldSocket.sent).toHaveLength(1); // hello only

    oldSocket.finishClose();
    await client.connect();
    const newSocket = FakeSocket.instances[1]!;
    newSocket.open();

    expect(newSocket.sent.map((frame) => JSON.parse(frame).type)).toEqual(["hello", "message.ack"]);
    client.close();
  });

  it("recognizes integration activity events emitted by integrations-svc", async () => {
    const { client } = makeClient();
    const socketEvents: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.on((event) => socketEvents.push(event.type));
    await client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "integration.activity.created",
        eventId: "00000000-0000-4000-8000-000000000001",
        orgId: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-09-30T09:00:00.000Z",
        recipientId: "00000000-0000-4000-8000-000000000003",
        activityId: "00000000-0000-4000-8000-000000000004",
        connectionId: "00000000-0000-4000-8000-000000000005",
        provider: "gmail",
        kind: "email",
        direction: "outbound",
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "message.created",
        eventId: "00000000-0000-4000-8000-000000000006",
        orgId: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-09-30T09:00:00.000Z",
        conversationId: "00000000-0000-4000-8000-000000000007",
        messageId: "00000000-0000-4000-8000-000000000008",
        seq: 1,
        senderId: "00000000-0000-4000-8000-000000000009",
        recipientId: "00000000-0000-4000-8000-000000000003",
        body: "hello",
        clientMsgId: "00000000-0000-4000-8000-000000000010",
      }),
    });

    expect(socketEvents).toContain("integration.activity.created");
    expect(socketEvents).toContain("message.created");
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
    client.close();
  });

  it("does not create competing sockets when close/connect overlap token lookup", async () => {
    let resolveToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { resolveToken = resolve; });
    const client = new WsClient({
      url: "wss://gateway.test/ws",
      getToken: () => token,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });

    const firstConnect = client.connect();
    client.close();
    const secondConnect = client.connect();
    resolveToken("token");
    await Promise.all([firstConnect, secondConnect]);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("is not disturbed by the late close of the socket it replaced", async () => {
    const { client, statuses } = makeClient();
    await client.connect();
    const [oldSocket] = FakeSocket.instances;
    oldSocket!.open();

    client.close();
    await client.connect(); // e.g. the org changed
    const newSocket = FakeSocket.instances[1]!;
    newSocket.open();
    expect(statuses.at(-1)).toBe("open");

    oldSocket!.finishClose(); // the old handshake finishes only now

    expect(statuses.at(-1)).toBe("open"); // not reported as closed
    await vi.advanceTimersByTimeAsync(25_000);
    expect(pings(newSocket)).toBeGreaterThanOrEqual(1); // heartbeat still running
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("still reconnects when the CURRENT socket drops", async () => {
    const { client, statuses } = makeClient();
    await client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    socket.finishClose();
    expect(statuses.at(-1)).toBe("closed");
    await vi.advanceTimersByTimeAsync(35_000);

    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("does not reconnect after a deliberate close", async () => {
    const { client } = makeClient();
    await client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.open();

    client.close();
    socket.finishClose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });
});
