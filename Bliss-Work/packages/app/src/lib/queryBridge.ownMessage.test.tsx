/**
 * The signed-in user's OWN messages through the socket bridge.
 *
 * This tab's send is shown as an optimistic `temp:` row, so its echo must not
 * be appended on top of it. A message the same user sent from another tab or
 * device (or a forward / missed-call notice posted for them) has no temp row
 * here and used to be dropped, so it never appeared in the open thread live.
 */
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type ChannelMessageDTO, type MessageDTO, type ServerEvent } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { WsEventBridge } from "./queryBridge";

const ws = vi.hoisted(() => ({ emit: undefined as ((e: unknown) => void) | undefined }));

vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { info: () => {}, error: () => {}, success: () => {} }) }));
vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: {},
    api: {},
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      onStatus: () => () => {},
      on: (cb: (e: unknown) => void) => {
        ws.emit = cb;
        return () => {};
      },
    },
  }),
}));

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const ORG = "55555555-5555-4555-8555-555555555555";
const REAL = "66666666-6666-4666-8666-666666666666";

vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) => sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));

let qc: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WsEventBridge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
});
afterEach(() => vi.useRealTimers());

const fire = (e: object) => act(() => ws.emit?.({ eventId: crypto.randomUUID(), orgId: ORG, occurredAt: "2026-10-07T10:00:00.000Z", ...e }));

const dm = (over: Partial<ServerEvent> = {}) => ({
  type: EventType.MessageCreated,
  conversationId: CONV,
  messageId: REAL,
  seq: 5,
  senderId: ME,
  recipientId: PEER,
  body: "hello",
  clientMsgId: crypto.randomUUID(),
  ...over,
});
const chan = (over: object = {}) => ({
  type: EventType.ChannelMessageCreated,
  channelId: CHANNEL,
  messageId: REAL,
  seq: 5,
  senderId: ME,
  senderUsername: "me",
  body: "hello",
  clientMsgId: crypto.randomUUID(),
  ...over,
});

const dmRow = (id: string, body: string, seq: number): MessageDTO =>
  ({ id, conversationId: CONV, seq, senderId: ME, body, createdAt: "2026-10-07T09:59:00.000Z" }) as MessageDTO;
const chanRow = (id: string, body: string, seq: number): ChannelMessageDTO =>
  ({ id, channelId: CHANNEL, seq, senderId: ME, senderUsername: "me", body, createdAt: "2026-10-07T09:59:00.000Z" }) as ChannelMessageDTO;

const dmIds = () => qc.getQueryData<MessageDTO[]>(qk.messages(CONV))?.map((m) => m.id);
const chanIds = () => qc.getQueryData<ChannelMessageDTO[]>(qk.channelMessages(CHANNEL))?.map((m) => m.id);

describe("own messages through the bridge (DM)", () => {
  it("appends a message of mine sent from another tab/device (no temp row here)", () => {
    qc.setQueryData(qk.messages(CONV), [dmRow("m1", "earlier", 4)]);
    fire(dm());
    expect(dmIds()).toEqual(["m1", REAL]);
  });

  it("appends my message when the pending temp row has a DIFFERENT body", () => {
    qc.setQueryData(qk.messages(CONV), [dmRow("temp:abc", "typing in this tab", 5)]);
    fire(dm({ body: "sent from my phone", seq: 6 }));
    expect(dmIds()).toEqual(["temp:abc", REAL]);
  });

  it("skips the echo of this tab's own pending send", () => {
    qc.setQueryData(qk.messages(CONV), [dmRow("temp:abc", "hello", 5)]);
    fire(dm());
    expect(dmIds()).toEqual(["temp:abc"]);
  });

  it("does not render twice once the 201 has already swapped in the real id", () => {
    qc.setQueryData(qk.messages(CONV), [dmRow(REAL, "hello", 5)]);
    fire(dm());
    expect(dmIds()).toEqual([REAL]);
  });

  it("still appends other people's messages", () => {
    qc.setQueryData(qk.messages(CONV), [dmRow("temp:abc", "hello", 5)]);
    fire(dm({ senderId: PEER }));
    expect(dmIds()).toEqual(["temp:abc", REAL]);
  });
});

describe("own messages through the bridge (channel)", () => {
  it("appends a message of mine sent from another tab/device", () => {
    qc.setQueryData(qk.channelMessages(CHANNEL), [chanRow("m1", "earlier", 4)]);
    fire(chan());
    expect(chanIds()).toEqual(["m1", REAL]);
  });

  it("skips the echo of this tab's own pending send", () => {
    qc.setQueryData(qk.channelMessages(CHANNEL), [chanRow("temp:abc", "hello", 5)]);
    fire(chan());
    expect(chanIds()).toEqual(["temp:abc"]);
  });
});
