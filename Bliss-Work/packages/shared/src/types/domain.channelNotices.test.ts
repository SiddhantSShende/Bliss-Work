import { describe, expect, it } from "vitest";
import { ChannelMessageCreated } from "./events";
import { ChannelMessageDTO, MessageKindWire } from "./domain";

/**
 * The channel membership notices must survive both inbound paths — the history
 * response and the live event — with their kind intact. MessageKindWire's
 * `.catch("text")` would otherwise turn an unknown kind into an ordinary message
 * from the actor, which is exactly what "Piyush removed Rahul from the channel"
 * must not look like.
 */
const KINDS = ["channel_created", "channel_member_added", "channel_member_removed", "channel_member_left"] as const;
const id = (n: number) => `123e4567-e89b-12d3-a456-42661417400${n}`;

describe("channel membership notice kinds on the wire", () => {
  it.each(KINDS)("%s round-trips through MessageKindWire", (kind) => {
    expect(MessageKindWire.parse(kind)).toBe(kind);
  });

  it.each(KINDS)("%s survives a channel history row", (kind) => {
    const row = ChannelMessageDTO.parse({
      id: id(1), channelId: id(2), seq: 3, senderId: id(4), senderUsername: "piyush",
      body: "Piyush removed Rahul from the channel", createdAt: "2026-10-09T10:00:00.000Z", kind,
    });
    expect(row.kind).toBe(kind);
  });

  it.each(KINDS)("%s survives the live channel.message.created event", (kind) => {
    const evt = ChannelMessageCreated.parse({
      type: "channel.message.created", eventId: id(5), orgId: id(6), occurredAt: "2026-10-09T10:00:00.000Z",
      channelId: id(2), messageId: id(1), seq: 3, senderId: id(4), senderUsername: "piyush",
      body: "Rahul left the channel", members: [id(4)], kind,
    });
    expect(evt.kind).toBe(kind);
  });
});
