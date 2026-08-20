import { describe, expect, it } from "vitest";
import {
  CHAT_MAX,
  CHAT_TEXT_MAX,
  chatFilename,
  chatToText,
  isChatEntry,
  mergeChat,
  newChatEntry,
  unreadSince,
  visibleToMe,
  visibleToPeer,
  type ChatEntry,
} from "./callChat";

const msg = (over: Partial<ChatEntry> = {}): ChatEntry => ({
  id: "alice-1000-abc",
  from: "alice",
  fromName: "Alice",
  to: null,
  text: "hello",
  at: 1000,
  ...over,
});

describe("isChatEntry — every field, because this comes off the wire", () => {
  it("accepts a well-formed public and private message", () => {
    expect(isChatEntry(msg())).toBe(true);
    expect(isChatEntry(msg({ to: "bob" }))).toBe(true);
  });

  it("rejects malformed input rather than trusting it", () => {
    expect(isChatEntry(null)).toBe(false);
    expect(isChatEntry("hello")).toBe(false);
    expect(isChatEntry(msg({ id: "" }))).toBe(false);
    expect(isChatEntry(msg({ from: "" }))).toBe(false);
    expect(isChatEntry(msg({ text: "" }))).toBe(false);
    expect(isChatEntry(msg({ at: Number.NaN }))).toBe(false);
    expect(isChatEntry({ ...msg(), to: 42 })).toBe(false);
    expect(isChatEntry(msg({ text: "x".repeat(CHAT_TEXT_MAX + 1) }))).toBe(false);
  });
});

describe("mergeChat", () => {
  it("dedupes by id — this is what stops a reconnect doubling the thread", () => {
    const a = msg({ id: "a", at: 1 });
    const b = msg({ id: "b", at: 2 });
    const merged = mergeChat([a, b], [a, b, a]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sorts by time so a late sync interleaves correctly", () => {
    const later = msg({ id: "b", at: 200 });
    const earlier = msg({ id: "a", at: 100 });
    expect(mergeChat([later], [earlier]).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns the SAME array when nothing was new, so the panel does not re-render", () => {
    const held = [msg({ id: "a" })];
    expect(mergeChat(held, [msg({ id: "a" })])).toBe(held);
  });

  it("drops malformed entries without losing the good ones", () => {
    const good = msg({ id: "good" });
    const merged = mergeChat([], [good, { nope: true } as unknown as ChatEntry]);
    expect(merged).toHaveLength(1);
  });

  it("keeps the newest when the cap bites", () => {
    const many = Array.from({ length: CHAT_MAX + 10 }, (_, i) =>
      msg({ id: `m${i}`, at: i }),
    );
    const merged = mergeChat([], many);
    expect(merged).toHaveLength(CHAT_MAX);
    expect(merged.at(-1)!.id).toBe(`m${CHAT_MAX + 9}`);
  });
});

describe("privacy", () => {
  it("never forwards a private exchange with someone else on catch-up", () => {
    // We hold a DM between us (alice) and carol. Bob asks what he missed.
    const withCarol = msg({ id: "p", from: "alice", to: "carol", text: "psst" });
    expect(visibleToPeer(withCarol, "bob")).toBe(false);
  });

  it("does forward the room's messages, and our DMs with the asker", () => {
    expect(visibleToPeer(msg({ to: null }), "bob")).toBe(true);
    expect(visibleToPeer(msg({ from: "alice", to: "bob" }), "bob")).toBe(true);
    expect(visibleToPeer(msg({ from: "bob", to: "alice" }), "bob")).toBe(true);
  });

  it("shows a viewer only what they are party to", () => {
    expect(visibleToMe(msg({ to: null }), "carol")).toBe(true);
    expect(visibleToMe(msg({ from: "alice", to: "bob" }), "carol")).toBe(false);
    expect(visibleToMe(msg({ from: "alice", to: "carol" }), "carol")).toBe(true);
    expect(visibleToMe(msg({ from: "carol", to: "alice" }), "carol")).toBe(true);
  });
});

describe("unreadSince", () => {
  const thread = [
    msg({ id: "a", from: "alice", at: 100 }),
    msg({ id: "b", from: "bob", at: 200 }),
    msg({ id: "c", from: "bob", at: 300 }),
  ];

  it("counts what arrived after the mark", () => {
    expect(unreadSince(thread, 150, "me")).toBe(2);
  });

  it("does not count your own messages as unread", () => {
    expect(unreadSince(thread, 150, "bob")).toBe(0);
  });

  it("is zero once everything has been seen", () => {
    expect(unreadSince(thread, 300, "me")).toBe(0);
  });
});

describe("newChatEntry", () => {
  it("builds a unique id from sender, time and a nonce", () => {
    const e = newChatEntry({ from: "alice", fromName: "Alice", to: null, text: "hi", at: 5, rand: "zz" });
    expect(e.id).toBe("alice-5-zz");
  });

  it("truncates rather than rejecting an over-long paste", () => {
    const e = newChatEntry({
      from: "alice",
      fromName: "Alice",
      to: null,
      text: "x".repeat(CHAT_TEXT_MAX + 50),
    });
    expect(e.text).toHaveLength(CHAT_TEXT_MAX);
    // And the result is still something the wire will accept.
    expect(isChatEntry(e)).toBe(true);
  });
});

describe("the downloaded transcript", () => {
  const nameOf = (id: string) => ({ bob: "Bob" })[id] ?? id;

  it("marks private messages, so the file does not misrepresent the meeting", () => {
    const text = chatToText("Standup", [msg({ to: "bob", text: "just you" })], nameOf);
    expect(text).toContain("(private to Bob)");
    expect(text).toContain("just you");
  });

  it("does not mark messages to the room", () => {
    expect(chatToText("Standup", [msg({ text: "all" })], nameOf)).not.toContain("private");
  });

  it("says so plainly when nothing was said", () => {
    expect(chatToText("Standup", [], nameOf)).toContain("(no messages were sent)");
  });

  it("names the meeting and the day in the filename", () => {
    expect(chatFilename("Weekly Sync!", new Date(2026, 7, 19))).toBe(
      "weekly-sync-chat-2026-08-19.txt",
    );
  });

  it("falls back to a usable name for an untitled meeting", () => {
    expect(chatFilename("", new Date(2026, 7, 19))).toBe("meeting-chat-2026-08-19.txt");
  });
});
