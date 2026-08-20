/**
 * Muting a conversation, and pinning one to the top of its list.
 *
 * Both live on the device because nothing on the server can hold them yet, and
 * that makes two things worth pinning. They must SURVIVE a reload — a mute that
 * quietly forgets itself is worse than no mute — and they must be namespaced by
 * scope, because a chat id and a channel id are UUIDs from two different tables
 * and a collision would mute the wrong conversation.
 *
 * The subscription is tested through a hook rather than by reading the module's
 * state: the menu toggles a value and the list beside it has to redraw, and
 * that is the only behaviour that matters.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  resetConversationPrefs,
  toggleConversationPref,
  useConversationPrefs,
} from "./conversationPrefs";

const CHAT = "018f0000-0000-7000-8000-0000000000c1";
const CHANNEL = "018f0000-0000-7000-8000-0000000000d1";
const STORAGE_KEY = "tb.conversation.prefs";

beforeEach(() => {
  localStorage.clear();
  resetConversationPrefs();
});

describe("conversation preferences", () => {
  it("starts with nothing set", () => {
    const { result } = renderHook(() => useConversationPrefs());
    expect(result.current.isMuted("chat", CHAT)).toBe(false);
    expect(result.current.hasShortcut("chat", CHAT)).toBe(false);
  });

  it("redraws whatever is watching the moment a preference flips", () => {
    const { result } = renderHook(() => useConversationPrefs());

    act(() => toggleConversationPref("muted", "chat", CHAT));
    expect(result.current.isMuted("chat", CHAT)).toBe(true);

    act(() => toggleConversationPref("muted", "chat", CHAT));
    expect(result.current.isMuted("chat", CHAT)).toBe(false);
  });

  it("keeps mute and shortcut apart", () => {
    const { result } = renderHook(() => useConversationPrefs());
    act(() => toggleConversationPref("shortcut", "chat", CHAT));
    expect(result.current.hasShortcut("chat", CHAT)).toBe(true);
    expect(result.current.isMuted("chat", CHAT)).toBe(false);
  });

  it("keeps a chat and a channel apart even if their ids ever collided", () => {
    const { result } = renderHook(() => useConversationPrefs());
    act(() => toggleConversationPref("muted", "chat", CHANNEL));
    expect(result.current.isMuted("chat", CHANNEL)).toBe(true);
    expect(result.current.isMuted("channel", CHANNEL)).toBe(false);
  });

  it("survives a reload", async () => {
    toggleConversationPref("muted", "channel", CHANNEL);
    expect(localStorage.getItem(STORAGE_KEY)).toContain(CHANNEL);

    // A fresh module instance is what a reload actually is.
    vi.resetModules();
    const reloaded = await import("./conversationPrefs");
    const { result } = renderHook(() => reloaded.useConversationPrefs());
    expect(result.current.isMuted("channel", CHANNEL)).toBe(true);
  });

  it("treats corrupt storage as nothing set rather than failing a render", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    vi.resetModules();
    const reloaded = await import("./conversationPrefs");
    const { result } = renderHook(() => reloaded.useConversationPrefs());
    expect(result.current.isMuted("chat", CHAT)).toBe(false);
  });

  it("ignores entries of the wrong shape inside otherwise valid storage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ muted: [`chat:${CHAT}`, 42, null], shortcut: "not an array" }),
    );
    vi.resetModules();
    const reloaded = await import("./conversationPrefs");
    const { result } = renderHook(() => reloaded.useConversationPrefs());
    expect(result.current.isMuted("chat", CHAT)).toBe(true);
    expect(result.current.hasShortcut("chat", CHAT)).toBe(false);
  });
});
