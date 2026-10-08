import { describe, expect, it } from "vitest";
import type { ChannelDTO, ConversationDTO } from "@taskboard/shared";
import { parseMessageNotificationText, resolveMessageNotification } from "./messageNotificationLabel";

const CHAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const conversation = (over: Partial<ConversationDTO> = {}) =>
  ({ id: CHAT, peerId: "p", peerUsername: "j.smith", peerDisplayName: "John Smith", ...over }) as ConversationDTO;
const channel = (over: Partial<ChannelDTO> = {}) => ({ id: CHANNEL, name: "Engineering", ...over }) as ChannelDTO;
const dm = (text: string) => ({ kind: "DM_MESSAGE", text, conversationId: CHAT, channelId: null });
const chan = (text: string) => ({ kind: "CHANNEL_MESSAGE", text, conversationId: null, channelId: CHANNEL });

describe("parseMessageNotificationText", () => {
  it("reads a DM's sender", () => {
    expect(parseMessageNotificationText("DM_MESSAGE", "Ann Lee: lunch?")).toEqual({ sender: "Ann Lee", channel: null });
  });
  it("reads a channel message's sender and channel", () => {
    expect(parseMessageNotificationText("CHANNEL_MESSAGE", "Ann Lee in #design: ready: yes")).toEqual({ sender: "Ann Lee", channel: "design" });
  });
  it("treats the producer's placeholders as unknown, not as a name", () => {
    expect(parseMessageNotificationText("DM_MESSAGE", "New message: hi")).toEqual({ sender: null, channel: null });
    expect(parseMessageNotificationText("CHANNEL_MESSAGE", "New message in #design: hi")).toEqual({ sender: null, channel: "design" });
    expect(parseMessageNotificationText("CHANNEL_MESSAGE", "New message in a channel: hi")).toEqual({ sender: null, channel: null });
  });
  it("keeps a sender the producer named even when it did not know the channel", () => {
    expect(parseMessageNotificationText("CHANNEL_MESSAGE", "Alloc Owner in a channel: Review")).toEqual({ sender: "Alloc Owner", channel: null });
  });
  it("copes with text that has no recognisable shape", () => {
    expect(parseMessageNotificationText("DM_MESSAGE", "")).toEqual({ sender: null, channel: null });
    expect(parseMessageNotificationText("CHANNEL_MESSAGE", "garbage")).toEqual({ sender: null, channel: null });
  });
});

describe("resolveMessageNotification", () => {
  it("names a DM's sender from the cached conversation's peer, by id", () => {
    expect(resolveMessageNotification(dm("New message: hi"), [conversation()], [])).toEqual({ sender: "John Smith", channel: null });
  });
  it("prefers the cached (current) display name over the producer's snapshot", () => {
    expect(resolveMessageNotification(dm("Johnny: hi"), [conversation()], []).sender).toBe("John Smith");
  });
  it("falls back to the producer's name, then the handle, then nothing", () => {
    expect(resolveMessageNotification(dm("Johnny: hi"), [], []).sender).toBe("Johnny");
    expect(resolveMessageNotification(dm("New message: hi"), [conversation({ peerDisplayName: undefined })], []).sender).toBe("j.smith");
    expect(resolveMessageNotification(dm("New message: hi"), [], []).sender).toBeNull();
  });
  it("ignores a conversation with another id", () => {
    expect(resolveMessageNotification(dm("New message: hi"), [conversation({ id: "other" })], []).sender).toBeNull();
  });
  it("names a channel from the channel list, by id, and the sender from the text", () => {
    expect(resolveMessageNotification(chan("John Smith in a channel: hi"), [], [channel()])).toEqual({ sender: "John Smith", channel: "Engineering" });
  });
  it("prefers the cached channel name over the snapshot (a renamed channel)", () => {
    expect(resolveMessageNotification(chan("John Smith in #old-name: hi"), [], [channel()]).channel).toBe("Engineering");
  });
  it("falls back to the snapshot when the channel is not cached (left or deleted)", () => {
    expect(resolveMessageNotification(chan("John Smith in #old-name: hi"), [], []).channel).toBe("old-name");
  });
  it("is all null when nothing is known — never an id or an address", () => {
    expect(resolveMessageNotification(chan("New message in a channel: hi"), [], [])).toEqual({ sender: null, channel: null });
  });
});
