/**
 * Contract tests for integration.mention.created — the event that drives the
 * "someone tagged me on a connected platform" hub feed.
 *
 * These pin three properties that are cheap to break and expensive to notice:
 *  1. the event stays PII-free (no peer/body ever rides the bus),
 *  2. it routes to the MENTIONED user, not the connection owner,
 *  3. it is exempt from delivery acks (it carries no messageId to ack).
 *
 * The Go mirror of the same rules is asserted in
 * services/ws-gateway/internal/contract/contract_test.go — both must agree.
 */
import { describe, expect, it } from "vitest";
import {
  DomainEvent,
  EventType,
  IntegrationMentionCreated,
  NO_DELIVERY_ACK_FOR,
  ServerEvent,
  recipientsOf,
} from "./events";

const MENTIONED_USER = "11111111-1111-1111-1111-111111111111";

const valid = {
  type: EventType.IntegrationMentionCreated,
  eventId: "01919e8a-0000-7000-8000-000000000001",
  orgId: "22222222-2222-2222-2222-222222222222",
  occurredAt: "2026-07-25T10:00:00.000Z",
  recipientId: MENTIONED_USER,
  activityId: "33333333-3333-3333-3333-333333333333",
  connectionId: "44444444-4444-4444-4444-444444444444",
  provider: "slack",
  kind: "message",
} as const;

describe("IntegrationMentionCreated schema", () => {
  it("parses a well-formed event", () => {
    expect(IntegrationMentionCreated.parse(valid)).toMatchObject({
      provider: "slack",
      recipientId: MENTIONED_USER,
    });
  });

  it.each(["recipientId", "activityId", "connectionId", "provider", "kind"])(
    "rejects a missing %s",
    (field) => {
      const { [field as keyof typeof valid]: _dropped, ...partial } = valid;
      expect(() => IntegrationMentionCreated.parse(partial)).toThrow();
    },
  );

  it("rejects a non-uuid recipientId", () => {
    expect(() => IntegrationMentionCreated.parse({ ...valid, recipientId: "me" })).toThrow();
  });

  it("carries no message body or peer — the client refetches instead", () => {
    const parsed = IntegrationMentionCreated.parse({ ...valid, body: "secret", peer: "boss@x.com" });
    expect(parsed).not.toHaveProperty("body");
    expect(parsed).not.toHaveProperty("peer");
  });
});

describe("union membership", () => {
  it("is pushable to a client socket", () => {
    expect(ServerEvent.parse(valid).type).toBe(EventType.IntegrationMentionCreated);
  });

  it("is a domain event on the bus", () => {
    expect(DomainEvent.parse(valid).type).toBe(EventType.IntegrationMentionCreated);
  });
});

describe("routing", () => {
  it("routes to the mentioned user only", () => {
    expect(recipientsOf(DomainEvent.parse(valid))).toEqual([MENTIONED_USER]);
  });
});

describe("delivery-ack exemption", () => {
  it.each([EventType.IntegrationMentionCreated, EventType.IntegrationActivityCreated])(
    "%s never generates a delivery ack",
    (type) => {
      expect(NO_DELIVERY_ACK_FOR.has(type)).toBe(true);
    },
  );
});
