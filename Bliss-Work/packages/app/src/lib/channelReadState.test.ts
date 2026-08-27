import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { markChannelViewed, resetChannelReadState, useChannelReadState } from "./channelReadState";

afterEach(() => {
  resetChannelReadState();
});

describe("useChannelReadState", () => {
  it("treats a channel with no lastMessageAt as read", () => {
    const { result } = renderHook(() => useChannelReadState());
    expect(result.current.isUnread("c1", null)).toBe(false);
  });

  it("treats a channel never viewed on this device as unread", () => {
    const { result } = renderHook(() => useChannelReadState());
    expect(result.current.isUnread("c1", "2024-01-01T00:00:00.000Z")).toBe(true);
  });

  it("becomes read once markChannelViewed runs after the last message", () => {
    const { result } = renderHook(() => useChannelReadState());
    act(() => markChannelViewed("c1"));
    expect(result.current.isUnread("c1", "2024-01-01T00:00:00.000Z")).toBe(false);
  });

  it("goes back to unread once a newer message arrives after the last view", () => {
    const { result } = renderHook(() => useChannelReadState());
    act(() => markChannelViewed("c1"));
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(result.current.isUnread("c1", future)).toBe(true);
  });

  it("scopes the mark to the channel it was recorded for", () => {
    const { result } = renderHook(() => useChannelReadState());
    act(() => markChannelViewed("c1"));
    expect(result.current.isUnread("c2", "2024-01-01T00:00:00.000Z")).toBe(true);
  });
});
