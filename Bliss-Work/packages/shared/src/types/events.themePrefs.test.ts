import { describe, expect, it } from "vitest";
import { EventType, ServerEvent, UserThemePrefsChanged } from "./events";

const id = "018f0000-0000-7000-8000-0000000000a1";

describe("account theme preference event contract", () => {
  it("accepts the signal-only user-scoped event", () => {
    const event = {
      type: EventType.UserThemePrefsChanged,
      eventId: id,
      orgId: id,
      occurredAt: "2026-10-16T08:00:00.000Z",
      userId: id,
    };

    expect(UserThemePrefsChanged.parse(event)).toEqual(event);
    expect(ServerEvent.parse(event)).toEqual(event);
  });

  it("rejects events without a valid account recipient", () => {
    expect(UserThemePrefsChanged.safeParse({
      type: EventType.UserThemePrefsChanged,
      eventId: id,
      orgId: id,
      occurredAt: "2026-10-16T08:00:00.000Z",
      userId: "not-a-user-id",
    }).success).toBe(false);
  });
});
