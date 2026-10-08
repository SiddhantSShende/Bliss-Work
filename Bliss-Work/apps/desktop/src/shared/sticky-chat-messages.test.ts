import { describe, expect, it, vi } from "vitest";
import {
  type ChatMsg,
  markSendFailed,
  mergeIncoming,
  sendStickyChatReply,
  tempIdFor,
  toStickyChatMessage,
} from "./sticky-chat-messages";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const temp: ChatMsg = {
  id: tempIdFor(CLIENT_ID),
  senderId: "me",
  body: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
  clientMsgId: CLIENT_ID,
};
const echo: ChatMsg = { id: "srv-1", senderId: "me", body: "hello", createdAt: "2026-01-01T00:00:01.000Z", clientMsgId: CLIENT_ID };

describe("toStickyChatMessage", () => {
  it("carries clientMsgId from the message.created event", () => {
    const m = toStickyChatMessage({
      messageId: "srv-1",
      senderId: "me",
      body: "hello",
      occurredAt: "2026-01-01T00:00:01.000Z",
      clientMsgId: CLIENT_ID,
    });
    expect(m).toEqual(echo);
  });
});

describe("mergeIncoming", () => {
  it("replaces the optimistic bubble with the server echo instead of showing it twice", () => {
    const peer: ChatMsg = { id: "p1", senderId: "peer", body: "yo", createdAt: "x" };
    const next = mergeIncoming([temp, peer], echo);
    expect(next).toEqual([echo, peer]);
  });

  it("appends a message from someone else", () => {
    const peer: ChatMsg = { id: "p1", senderId: "peer", body: "yo", createdAt: "x", clientMsgId: "other" };
    expect(mergeIncoming([temp], peer)).toEqual([temp, peer]);
  });

  it("ignores a message id it already has", () => {
    const prev = [echo];
    expect(mergeIncoming(prev, echo)).toBe(prev);
  });

  it("keeps only the 50 most recent", () => {
    const prev = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, senderId: "p", body: "b", createdAt: "x" }));
    const next = mergeIncoming(prev, echo);
    expect(next).toHaveLength(50);
    expect(next[49]).toBe(echo);
    expect(next[0]!.id).toBe("m1");
  });
});

describe("markSendFailed", () => {
  it("flags only the matching optimistic bubble", () => {
    const other: ChatMsg = { ...temp, id: tempIdFor("zzz"), clientMsgId: "zzz" };
    const next = markSendFailed([temp, other], CLIENT_ID);
    expect(next[0]!.failed).toBe(true);
    expect(next[1]!.failed).toBeUndefined();
  });

  it("a late echo clears the failed state by replacing the bubble", () => {
    expect(mergeIncoming(markSendFailed([temp], CLIENT_ID), echo)).toEqual([echo]);
  });
});

describe("sendStickyChatReply", () => {
  const req = { threadId: "t1", body: "hello", clientMsgId: CLIENT_ID };

  it("sends with the caller's clientMsgId and reports nothing on success", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const onFailed = vi.fn();
    await sendStickyChatReply(reply, req, onFailed);
    expect(reply).toHaveBeenCalledWith("t1", "hello", { clientMsgId: CLIENT_ID });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports a rejected send", async () => {
    const onFailed = vi.fn();
    await sendStickyChatReply(vi.fn().mockRejectedValue(new Error("500")), req, onFailed);
    expect(onFailed).toHaveBeenCalledWith("t1", CLIENT_ID);
  });

  it("reports a send attempted before the API client exists", async () => {
    const onFailed = vi.fn();
    await sendStickyChatReply(undefined, req, onFailed);
    expect(onFailed).toHaveBeenCalledWith("t1", CLIENT_ID);
  });
});
