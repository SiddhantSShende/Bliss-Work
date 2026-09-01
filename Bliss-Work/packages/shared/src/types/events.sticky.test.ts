import { describe, expect, it } from "vitest";
import { EventType, ServerEvent, StickyRefresh } from "./events";
import { DomainEvent, recipientsOf } from "./event-routing-spec";

/**
 * THE THREE-PLACE CONTRACT.
 *
 * `sticky.refresh` is produced by a Go service (services/sticky-relay), routed
 * by another Go service (ws-gateway), and consumed by this TypeScript client.
 * None of the three can import the others, and the failure mode when they drift
 * is SILENT: WsClient.ts drops any frame that fails to parse, with nothing but a
 * console warning — which looks exactly like the producer not running.
 *
 * The payload below is byte-identical to what
 * services/sticky-relay/internal/emit/producer.go writes, and that file has the
 * matching test on its side.
 */

/** Exactly what the Go producer marshals. */
const wireFrame = {
  type: "sticky.refresh" as const,
  eventId: "018f0000-0000-7000-8000-0000000000e1",
  orgId: "018f0000-0000-7000-8000-000000000001",
  occurredAt: "2026-09-01T12:00:00.000Z",
  assigneeId: "018f0000-0000-7000-8000-0000000000a1",
  pinCount: 3,
};

describe("sticky.refresh crosses the wire intact", () => {
  it("parses as a ServerEvent, so WsClient does not drop it", () => {
    // The assertion that matters. Adding the schema but forgetting the union is
    // the single most likely way to ship this feature silently broken.
    const parsed = ServerEvent.safeParse(wireFrame);
    expect(parsed.success).toBe(true);
  });

  it("parses on its own schema too", () => {
    expect(StickyRefresh.safeParse(wireFrame).success).toBe(true);
  });

  it("uses the same discriminant string as the Go producer", () => {
    expect(EventType.StickyRefresh).toBe("sticky.refresh");
  });

  it("rejects a frame missing the recipient", () => {
    const { assigneeId, ...withoutRecipient } = wireFrame;
    expect(ServerEvent.safeParse(withoutRecipient).success).toBe(false);
  });

  it("rejects a negative pin count", () => {
    expect(StickyRefresh.safeParse({ ...wireFrame, pinCount: -1 }).success).toBe(false);
  });
});

describe("sticky.refresh routing matches ws-gateway", () => {
  it("goes to the assignee and nobody else", () => {
    // Routed through the schema first, so this asserts on the same value the
    // gateway would actually have — not on a hand-built object that merely
    // looks like one. Mirrors `case "sticky.refresh"` in
    // services/ws-gateway/internal/contract/contract.go. The event carries no
    // task content, so there is no second party who could want it.
    const parsed = DomainEvent.parse(wireFrame);
    expect(recipientsOf(parsed)).toEqual([wireFrame.assigneeId]);
  });
});
