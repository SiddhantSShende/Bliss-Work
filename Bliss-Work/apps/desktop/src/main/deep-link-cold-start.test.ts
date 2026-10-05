import { describe, expect, it, vi } from "vitest";
import { createOpenUrlHandler } from "./deep-link-cold-start";

const INVITE = "taskboard://invite?token=abc";
const MEETING = "taskboard://join?t=xyz";

function setup(ready: boolean) {
  const state = { ready };
  const deliver = vi.fn();
  const handler = createOpenUrlHandler({ isReady: () => state.ready, deliver });
  return { state, deliver, handler };
}

describe("createOpenUrlHandler", () => {
  it("holds a link that arrives before the app is ready instead of delivering it", () => {
    const { handler, deliver } = setup(false);

    handler.handle(INVITE);

    expect(deliver).not.toHaveBeenCalled();
    expect(handler.takeHeld()).toBe(INVITE);
  });

  it("hands the held link over once, then forgets it", () => {
    const { handler } = setup(false);
    handler.handle(MEETING);

    expect(handler.takeHeld()).toBe(MEETING);
    expect(handler.takeHeld()).toBeUndefined();
  });

  it("keeps the latest link when several arrive before ready", () => {
    const { handler } = setup(false);
    handler.handle(INVITE);
    handler.handle(MEETING);

    expect(handler.takeHeld()).toBe(MEETING);
  });

  it("does not hold a URL this app does not handle", () => {
    const { handler } = setup(false);
    handler.handle("https://example.com/?token=abc");
    handler.handle("taskboard://unknown");

    expect(handler.takeHeld()).toBeUndefined();
  });

  it("delivers immediately, and holds nothing, once the app is ready", () => {
    const { handler, deliver } = setup(true);

    handler.handle(INVITE);

    expect(deliver).toHaveBeenCalledWith(INVITE);
    expect(handler.takeHeld()).toBeUndefined();
  });

  it("switches from holding to delivering when the app becomes ready", () => {
    const { state, handler, deliver } = setup(false);
    handler.handle(INVITE);

    state.ready = true;
    handler.handle(MEETING);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(MEETING);
    expect(handler.takeHeld()).toBe(INVITE);
  });
});
