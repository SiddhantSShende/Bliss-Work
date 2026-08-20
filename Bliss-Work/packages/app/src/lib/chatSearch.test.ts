/**
 * Searching inside one conversation.
 *
 * The rule worth pinning is that the search reads the READABLE body: an
 * attachment message's body is an envelope, and matching it raw would let a
 * query like "media" or "image" hit every photo in the thread through its JSON
 * — results the reader cannot see the reason for.
 */
import { describe, it, expect } from "vitest";
import { searchMessages } from "./chatSearch";
import { encodeMedia } from "./chatEnvelope";

const photo = encodeMedia([
  { id: "018f0000-0000-7000-8000-00000000000a", name: "roadmap.png", size: 2048, mime: "image/png" },
]);

const thread = [
  { body: "Morning — did the deploy land?", senderName: "Ada Lovelace" },
  { body: "Yes, an hour ago", senderName: "Bo Carter" },
  { body: photo, senderName: "Bo Carter" },
];

describe("searchMessages", () => {
  it("returns everything for an empty or whitespace-only query", () => {
    expect(searchMessages(thread, "")).toHaveLength(3);
    expect(searchMessages(thread, "   ")).toHaveLength(3);
  });

  it("matches the message text, case-insensitively", () => {
    expect(searchMessages(thread, "DEPLOY").map((m) => m.senderName)).toEqual(["Ada Lovelace"]);
  });

  it("matches the sender, so 'who said what' is one query", () => {
    expect(searchMessages(thread, "bo")).toHaveLength(2);
  });

  it("searches an attachment by its filename, not by its envelope", () => {
    expect(searchMessages(thread, "roadmap")).toHaveLength(1);
    // "media" and the envelope's other JSON keys are not text anybody typed.
    expect(searchMessages(thread, "kind")).toHaveLength(0);
    expect(searchMessages(thread, "018f0000")).toHaveLength(0);
  });

  it("keeps the thread's own order", () => {
    // All three carry an "o" — in the text, in the sender, in the filename — so
    // a filter that reorders would be visible here.
    expect(searchMessages(thread, "o").map((m) => m.body)).toEqual(thread.map((m) => m.body));
  });

  it("does not hand back the caller's array to mutate", () => {
    const out = searchMessages(thread, "");
    expect(out).not.toBe(thread);
  });
});
