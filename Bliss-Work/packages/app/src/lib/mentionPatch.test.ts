import { describe, expect, it } from "vitest";
import type { MentionDTO } from "@taskboard/shared";
import {
  countMentions,
  dropMention,
  flatMentions,
  markClaimed,
  type MentionPages,
} from "./mentionPatch";

const mention = (id: string, over: Partial<MentionDTO> = {}): MentionDTO => ({
  id,
  provider: "slack",
  kind: "message",
  peer: "U0123",
  body: "please review",
  threadRef: "C1/1712.0",
  permalink: null,
  state: "pending",
  taskId: null,
  occurredAt: "2026-07-25T10:00:00.000Z",
  ...over,
});

const pages = (...groups: MentionDTO[][]): MentionPages => ({
  pages: groups.map((items, i) => ({
    items,
    nextCursor: i === groups.length - 1 ? null : `cursor-${i}`,
  })),
  pageParams: groups.map((_, i) => (i === 0 ? undefined : `cursor-${i - 1}`)),
});

describe("dropMention", () => {
  it("removes the row from the page holding it", () => {
    const data = pages([mention("a"), mention("b")], [mention("c")]);
    const out = dropMention(data, "b")!;
    expect(flatMentions(out).map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("removes from a later page too", () => {
    const data = pages([mention("a")], [mention("b"), mention("c")]);
    expect(flatMentions(dropMention(data, "c")).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("leaves nextCursor alone — it encodes a server-side position", () => {
    // Rewriting it after a local removal would make the next fetch skip a row.
    const data = pages([mention("a"), mention("b")], [mention("c")]);
    const out = dropMention(data, "a")!;
    expect(out.pages.map((p) => p.nextCursor)).toEqual(["cursor-0", null]);
  });

  it("keeps page structure when a page empties out", () => {
    const data = pages([mention("a")], [mention("b")]);
    const out = dropMention(data, "a")!;
    expect(out.pages).toHaveLength(2);
    expect(out.pages[0]!.items).toEqual([]);
  });

  it("is a no-op for an unknown id, preserving reference identity", () => {
    // Same reference ⇒ TanStack Query skips a pointless re-render.
    const data = pages([mention("a")]);
    expect(dropMention(data, "zzz")).toBe(data);
  });

  it("does not mutate the input", () => {
    const data = pages([mention("a"), mention("b")]);
    dropMention(data, "a");
    expect(data.pages[0]!.items.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("handles an unfetched cache", () => {
    expect(dropMention(undefined, "a")).toBeUndefined();
  });
});

describe("markClaimed", () => {
  it("flips state and records the task id", () => {
    const data = pages([mention("a"), mention("b")]);
    const out = markClaimed(data, "a", "task-9")!;
    const row = flatMentions(out).find((m) => m.id === "a")!;
    expect(row.state).toBe("claimed");
    expect(row.taskId).toBe("task-9");
  });

  it("leaves other rows untouched", () => {
    const data = pages([mention("a"), mention("b")]);
    const out = markClaimed(data, "a", "task-9")!;
    expect(flatMentions(out).find((m) => m.id === "b")!.state).toBe("pending");
  });

  it("is a no-op for an unknown id", () => {
    const data = pages([mention("a")]);
    expect(markClaimed(data, "zzz", "task-9")).toBe(data);
  });

  it("does not mutate the input", () => {
    const data = pages([mention("a")]);
    markClaimed(data, "a", "task-9");
    expect(data.pages[0]!.items[0]!.state).toBe("pending");
  });

  it("handles an unfetched cache", () => {
    expect(markClaimed(undefined, "a", "t")).toBeUndefined();
  });
});

describe("flatMentions / countMentions", () => {
  it("flattens pages in order", () => {
    const data = pages([mention("a"), mention("b")], [mention("c")]);
    expect(flatMentions(data).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(countMentions(data)).toBe(3);
  });

  it("returns an empty list before the first fetch", () => {
    expect(flatMentions(undefined)).toEqual([]);
    expect(countMentions(undefined)).toBe(0);
  });
});
