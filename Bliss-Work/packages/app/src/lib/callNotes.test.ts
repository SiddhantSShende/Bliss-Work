import { describe, expect, it } from "vitest";
import { isNoteEntry, NOTE_TEXT_MAX, type NoteEntry } from "./callNotes";

const note = (over: Partial<NoteEntry> = {}): NoteEntry => ({
  id: "alice-1000-abc",
  author: "Alice",
  text: "an important point",
  at: 1000,
  ...over,
});

describe("isNoteEntry — every field, because this comes off the wire", () => {
  it("accepts a well-formed note", () => {
    expect(isNoteEntry(note())).toBe(true);
  });

  it("rejects malformed input rather than trusting it", () => {
    expect(isNoteEntry(null)).toBe(false);
    expect(isNoteEntry("hello")).toBe(false);
    expect(isNoteEntry(note({ id: "" }))).toBe(false);
    expect(isNoteEntry(note({ text: "" }))).toBe(false);
    expect(isNoteEntry(note({ at: Number.NaN }))).toBe(false);
    expect(isNoteEntry(note({ text: "x".repeat(NOTE_TEXT_MAX + 1) }))).toBe(false);
  });

  // Regression: NOTE_TEXT_MAX bounds UTF-8 BYTES, matching the server's
  // CallTranscriptTextMax — not JS's UTF-16 .length. 300 Japanese characters
  // is comfortably under 500 by .length (a check that used to pass here) but
  // 900 bytes on the wire, well over the server's actual cap.
  it("rejects text that is under the char count but over the byte cap", () => {
    const overByBytes = "あ".repeat(300); // 300 chars, 900 UTF-8 bytes
    expect(overByBytes.length).toBeLessThan(NOTE_TEXT_MAX);
    expect(isNoteEntry(note({ text: overByBytes }))).toBe(false);
  });

  it("accepts multi-byte text that fits within the byte cap", () => {
    const underByBytes = "あ".repeat(150); // 150 chars, 450 UTF-8 bytes
    expect(isNoteEntry(note({ text: underByBytes }))).toBe(true);
  });
});
