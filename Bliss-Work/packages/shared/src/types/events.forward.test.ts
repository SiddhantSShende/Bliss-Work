/**
 * The forward contract, and the compatibility guard that stops one new message
 * kind from taking a whole conversation down with it.
 *
 * ApiClient.req throws ApiError(502, "invalid response from server") whenever a
 * response fails safeParse, and WsClient silently drops frames that fail it. So
 * with a bare z.enum, the first `kind` the server writes that a client has never
 * heard of does not degrade that one message — it fails the entire `messages`
 * response, and the conversation refuses to load. The desktop app updates on its
 * own electron-updater cadence and has historically run weeks behind the web
 * app, so "an old client is in the field" is the normal case, not the edge case.
 */
import { describe, expect, it } from "vitest";

import { ChannelMessageDTO, ForwardEdgeDTO, MessageDTO } from "./domain";
import { MessageCreated, MessageForwarded, recipientsOf } from "./events";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("MessageKind wire tolerance", () => {
  it("parses the new forward_external kind", () => {
    const parsed = MessageDTO.parse({
      id: uuid(1),
      conversationId: uuid(2),
      seq: 1,
      senderId: uuid(3),
      body: "Opened WhatsApp to forward this to Jane Doe (+15550192834)",
      createdAt: new Date(0).toISOString(),
      kind: "forward_external",
    });
    expect(parsed.kind).toBe("forward_external");
  });

  it("degrades an UNKNOWN kind to text instead of failing the payload", () => {
    // This is the test that would have caught the 502. If someone replaces
    // MessageKindWire with the bare enum, this fails.
    const parsed = MessageDTO.parse({
      id: uuid(1),
      conversationId: uuid(2),
      seq: 1,
      senderId: uuid(3),
      body: "from a newer server",
      createdAt: new Date(0).toISOString(),
      kind: "some_kind_from_the_future",
    });
    expect(parsed.kind).toBe("text");
  });

  it("applies the same tolerance to channel messages and to the WS event", () => {
    expect(
      ChannelMessageDTO.parse({
        id: uuid(1),
        channelId: uuid(2),
        seq: 1,
        senderId: uuid(3),
        senderUsername: "alice",
        body: "hi",
        createdAt: new Date(0).toISOString(),
        kind: "not_a_kind_yet",
      }).kind,
    ).toBe("text");

    expect(
      MessageCreated.parse({
        type: "message.created",
        eventId: uuid(9),
        orgId: uuid(8),
        occurredAt: new Date(0).toISOString(),
        conversationId: uuid(2),
        messageId: uuid(1),
        seq: 1,
        senderId: uuid(3),
        recipientId: uuid(4),
        body: "hi",
        clientMsgId: uuid(5),
        kind: "not_a_kind_yet",
      }).kind,
    ).toBe("text");
  });
});

describe("MessageForwarded", () => {
  const base = {
    type: "message.forwarded" as const,
    eventId: uuid(9),
    orgId: uuid(8),
    occurredAt: new Date(0).toISOString(),
    conversationId: uuid(2),
    rootMessageId: uuid(1),
    rootAuthorId: uuid(3),
    parentMessageId: uuid(1),
    forwardedBy: uuid(4),
    platform: "whatsapp",
    depth: 1,
    bodyPreview: "ship it",
  };

  it("parses a payload from before deep-link forwarding, with no delivery field", () => {
    const parsed = MessageForwarded.parse({ ...base, forwardedToExternal: "15550192834" });
    // Absent must not mean "unknown" — every pre-existing row was confirmed.
    expect(parsed.delivery).toBeUndefined();
  });

  it("carries delivery, the contact name and a channel source", () => {
    const parsed = MessageForwarded.parse({
      ...base,
      forwardedToExternal: "15550192834",
      forwardedToName: "Jane Doe",
      channelId: uuid(7),
      delivery: "unconfirmed",
    });
    expect(parsed.delivery).toBe("unconfirmed");
    expect(parsed.forwardedToName).toBe("Jane Doe");
    expect(parsed.channelId).toBe(uuid(7));
  });

  it("routes an external forward to the forwarder and the original author only", () => {
    // Never to the whole channel: the pill is what every member sees, and it
    // carries no phone number. This event does, so its audience stays narrow.
    const evt = MessageForwarded.parse({
      ...base,
      channelId: uuid(7),
      forwardedToExternal: "15550192834",
      delivery: "unconfirmed",
    });
    expect(recipientsOf(evt).sort()).toEqual([uuid(3), uuid(4)].sort());
  });
});

describe("ForwardEdgeDTO", () => {
  it("defaults delivery to confirmed for rows written before the column existed", () => {
    const parsed = ForwardEdgeDTO.parse({
      id: uuid(1),
      rootMessageId: uuid(2),
      rootAuthorId: uuid(3),
      parentMessageId: uuid(2),
      forwardedBy: uuid(4),
      platform: "blisswork",
      depth: 1,
      createdAt: new Date(0).toISOString(),
      delivery: "something_unexpected",
    });
    expect(parsed.delivery).toBe("confirmed");
  });
});
