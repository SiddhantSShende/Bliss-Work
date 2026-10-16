import { describe, expect, it } from "vitest";
import { isNoteEntry, mergeNotes, unreadNotesSince, type NoteEntry } from "./callNotes";

function note(partial: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id: "a-1-xxxx",
    from: "alice",
    author: "Alice",
    text: "Point one",
    at: 1_000,
    ...partial,
  };
}

describe("isNoteEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(isNoteEntry(note())).toBe(true);
  });

  it("rejects an entry missing the writer's identity", () => {
    const { from, ...rest } = note();
    expect(isNoteEntry(rest)).toBe(false);
  });

  it("rejects a non-string identity (a participant claiming someone else's shape)", () => {
    expect(isNoteEntry({ ...note(), from: 42 })).toBe(false);
  });
});

describe("mergeNotes — duplicate/reconnect-resync events", () => {
  it("collapses the same note arriving twice (sync-on-join + the live broadcast)", () => {
    const held = mergeNotes([], [note({ id: "a-1" })]);
    const after = mergeNotes(held, [note({ id: "a-1" })]);
    expect(after).toHaveLength(1);
  });

  it("collapses a note re-sent again after a reconnect's catch-up request", () => {
    const held = mergeNotes([], [note({ id: "a-1", at: 1_000 })]);
    // Simulates a fresh notes-sync answer received again after the data
    // channel reconnects — the same entry, offered again by every peer.
    const resynced = mergeNotes(held, [note({ id: "a-1", at: 1_000 }), note({ id: "a-1", at: 1_000 })]);
    expect(resynced).toHaveLength(1);
  });

  it("keeps distinct notes from multiple participants", () => {
    const merged = mergeNotes(
      [],
      [note({ id: "a-1", from: "alice", at: 1_000 }), note({ id: "b-1", from: "bob", at: 2_000 })],
    );
    expect(merged.map((n) => n.id)).toEqual(["a-1", "b-1"]);
  });

  it("drops an entry that fails validation rather than crashing the merge", () => {
    const merged = mergeNotes([], [note({ id: "a-1" }), { bogus: true } as unknown as NoteEntry]);
    expect(merged).toHaveLength(1);
  });
});

describe("unreadNotesSince", () => {
  const seenAt = 1_000;

  it("counts a note from someone else written after the mark", () => {
    const notes = [note({ from: "bob", at: 2_000 })];
    expect(unreadNotesSince(notes, seenAt, "alice")).toBe(1);
  });

  it("does not count your own note (not news to you)", () => {
    const notes = [note({ from: "alice", at: 2_000 })];
    expect(unreadNotesSince(notes, seenAt, "alice")).toBe(0);
  });

  it("does not count a note written before the mark — opening the panel clears it", () => {
    const notes = [note({ from: "bob", at: 500 })];
    expect(unreadNotesSince(notes, seenAt, "alice")).toBe(0);
  });

  it("counts every distinct unseen note from others, once each, with no duplicates", () => {
    const notes = [
      note({ id: "b-1", from: "bob", at: 2_000 }),
      note({ id: "b-2", from: "bob", at: 3_000 }),
      note({ id: "c-1", from: "carol", at: 4_000 }),
    ];
    expect(unreadNotesSince(notes, seenAt, "alice")).toBe(3);
  });
});
