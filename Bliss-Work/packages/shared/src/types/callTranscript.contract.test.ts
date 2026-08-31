/**
 * The other half of the meeting-transcript wire contract.
 *
 * services/messaging-svc/internal/store/call_transcript_wire_test.go pins the
 * EXACT JSON the server emits; this parses those same literals through the
 * schemas the client reads them with.
 *
 * Both halves are needed because neither failure mode is loud on its own. A
 * renamed Go json tag fails nothing here at runtime — `items` defaults to `[]`
 * and `nextCursor` is nullish — so the meeting simply renders as one where
 * nobody said anything, which is indistinguishable from the truth. Pinning the
 * literal in both places is what makes that a failing test instead of a
 * bug report about "the transcript is always empty".
 */
import { describe, expect, it } from "vitest";
import {
  CallChatMessageDTO,
  CallChatPageDTO,
  CallNoteDTO,
  CallNotePageDTO,
  CallPageDTO,
} from "./domain";

// ⚠️ These literals are COPIES of the ones in call_transcript_wire_test.go.
// Change one and change the other, in the same commit.
const CHAT_MESSAGE = {
  id: "11111111-1111-1111-1111-111111111111",
  callId: "22222222-2222-2222-2222-222222222222",
  senderId: "33333333-3333-3333-3333-333333333333",
  text: "Shall we ship it?",
  sentAt: "2026-08-01T09:10:00.000Z",
};

const NOTE = {
  id: "44444444-4444-4444-4444-444444444444",
  callId: "22222222-2222-2222-2222-222222222222",
  authorId: "55555555-5555-5555-5555-555555555555",
  text: "Decide the rollout date",
  writtenAt: "2026-08-01T09:20:00.000Z",
};

describe("meeting transcript wire contract", () => {
  it("parses a chat message exactly as messaging-svc emits it", () => {
    const parsed = CallChatMessageDTO.parse(CHAT_MESSAGE);
    expect(parsed.senderId).toBe("33333333-3333-3333-3333-333333333333");
    expect(parsed.text).toBe("Shall we ship it?");
    expect(parsed.sentAt).toBe("2026-08-01T09:10:00.000Z");
  });

  it("parses a note exactly as messaging-svc emits it", () => {
    const parsed = CallNoteDTO.parse(NOTE);
    expect(parsed.authorId).toBe("55555555-5555-5555-5555-555555555555");
    expect(parsed.text).toBe("Decide the rollout date");
    expect(parsed.writtenAt).toBe("2026-08-01T09:20:00.000Z");
  });

  it("reads a full page and its cursor", () => {
    const page = CallChatPageDTO.parse({ items: [CHAT_MESSAGE], nextCursor: "eyJhdCI6IjIwMjYifQ" });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("eyJhdCI6IjIwMjYifQ");
  });

  it("reads the LAST page — an explicit null cursor is what stops the paging", () => {
    const page = CallNotePageDTO.parse({ items: [NOTE], nextCursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor ?? null).toBeNull();
  });

  it("reads an empty transcript without inventing one", () => {
    const page = CallChatPageDTO.parse({ items: [], nextCursor: null });
    expect(page.items).toEqual([]);
  });

  it("reads a history page with no meetings in it", () => {
    const page = CallPageDTO.parse({ items: [], nextCursor: null });
    expect(page.items).toEqual([]);
    expect(page.nextCursor ?? null).toBeNull();
  });

  /**
   * The guard that gives the pin its teeth. A renamed field must be a REFUSED
   * parse, not a silently empty one — so the schemas must not make the payload
   * fields optional.
   */
  it("REFUSES a message whose fields have been renamed, rather than dropping them", () => {
    expect(() =>
      CallChatMessageDTO.parse({ ...CHAT_MESSAGE, senderId: undefined, sender_id: "x" }),
    ).toThrow();
    expect(() => CallNoteDTO.parse({ ...NOTE, writtenAt: undefined, written_at: "x" })).toThrow();
  });
});
