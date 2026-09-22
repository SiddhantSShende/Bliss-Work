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
