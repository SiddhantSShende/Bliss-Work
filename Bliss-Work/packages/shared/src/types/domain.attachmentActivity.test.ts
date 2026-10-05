import { describe, expect, it } from "vitest";
import { ChannelMessageDTO, MessageDTO, MessageKind, MessageKindWire } from "./domain";

/**
 * The two file-activity kinds, on the wire.
 *
 * This is the "survives a page reload" guarantee for the feature: a GET
 * response fetched fresh (as opposed to the value the client minted for its
 * own optimistic cache patch) has to parse with `kind` intact, or
 * MessageKindWire's `.catch("text")` fallback silently degrades it to a
 * plain bubble — see that field's doc comment for why the fallback exists
 * (an unknown kind must not fail the whole page), which is exactly the
 * failure mode this test rules out for a BUILD THAT DOES KNOW these kinds.
 */
describe("attachment activity kinds on the wire", () => {
  it.each(["attachment_opened", "attachment_downloaded"] as const)(
    "%s is a valid MessageKind",
    (kind) => {
      expect(MessageKind.safeParse(kind).success).toBe(true);
    },
  );

  it.each(["attachment_opened", "attachment_downloaded"] as const)(
    "%s round-trips through MessageKindWire unchanged (does not fall back to text)",
    (kind) => {
      expect(MessageKindWire.parse(kind)).toBe(kind);
    },
  );

  it("a full MessageDTO (DM) keeps kind = attachment_downloaded after parsing", () => {
    const wire = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      conversationId: "223e4567-e89b-12d3-a456-426614174000",
      seq: 4,
      senderId: "323e4567-e89b-12d3-a456-426614174000",
      body: "Priya downloaded Report.pdf",
      createdAt: "2026-09-25T00:00:00Z",
      kind: "attachment_downloaded",
    };
    const parsed = MessageDTO.parse(wire);
    expect(parsed.kind).toBe("attachment_downloaded");
    expect(parsed.body).toBe("Priya downloaded Report.pdf");
  });

  it("a full ChannelMessageDTO keeps kind = attachment_opened after parsing", () => {
    const wire = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      channelId: "223e4567-e89b-12d3-a456-426614174000",
      seq: 7,
      senderId: "323e4567-e89b-12d3-a456-426614174000",
      senderUsername: "priya",
      senderDisplayName: "Priya Nair",
      body: "Priya Nair opened Roadmap.key",
      createdAt: "2026-09-25T00:00:00Z",
      kind: "attachment_opened",
    };
    const parsed = ChannelMessageDTO.parse(wire);
    expect(parsed.kind).toBe("attachment_opened");
  });

  // The safety net these two kinds rely on for an OLDER build that has never
  // heard of them: an unrecognized kind degrades to "text" rather than
  // failing the whole messages response (see MessageKindWire's doc comment).
  it("an unknown kind still degrades to text rather than failing the parse", () => {
    expect(MessageKindWire.parse("some_future_kind")).toBe("text");
  });
});
