import { describe, expect, it } from "vitest";
import { ActivitySource, TimelineEntry } from "./domain";

describe("mobile activity source", () => {
  it("parses mobile timeline entries", () => {
    expect(ActivitySource.parse("mobile")).toBe("mobile");
    expect(
      TimelineEntry.parse({
        id: "activity-1",
        occurredAt: "2026-10-01T10:00:00Z",
        source: "mobile",
        category: "security",
        action: "screen.locked",
      }).source,
    ).toBe("mobile");
  });
});
