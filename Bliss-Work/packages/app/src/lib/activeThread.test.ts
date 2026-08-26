/**
 * The one property this store exists to guarantee: a view's own cleanup can
 * never blank a DIFFERENT view's registration.
 *
 * DMView and ChannelView both write "I'm the open thread" on mount and clear
 * it on unmount. React does not guarantee the outgoing view's cleanup runs
 * before the incoming view's effect — switching from a chat to a channel can
 * run either order — so an unguarded clear would be a coin flip between
 * "channel correctly registered" and "nothing registered at all". The identity
 * check in clearActiveThread is what makes it not a coin flip; this is the
 * regression that guard exists to prevent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useActiveThread, type ActiveThread } from "./activeThread";

const CHAT: ActiveThread = { kind: "chat", conversationId: "c1", peerId: "p1", peerName: "Alice" };
const CHANNEL: ActiveThread = { kind: "channel", channelId: "ch1" };

describe("useActiveThread", () => {
  beforeEach(() => {
    useActiveThread.setState({ thread: null });
  });

  it("starts with no active thread", () => {
    expect(useActiveThread.getState().thread).toBeNull();
  });

  it("set then clear round-trips to null", () => {
    useActiveThread.getState().setActiveThread(CHAT);
    expect(useActiveThread.getState().thread).toEqual(CHAT);
    useActiveThread.getState().clearActiveThread(CHAT);
    expect(useActiveThread.getState().thread).toBeNull();
  });

  it("a stale clear from the PREVIOUS view does not blank the NEW view's registration", () => {
    // DMView registers, the user switches to a channel, ChannelView registers
    // — then DMView's own unmount cleanup finally runs and tries to clear
    // what it set. It must not touch the channel's registration.
    useActiveThread.getState().setActiveThread(CHAT);
    useActiveThread.getState().setActiveThread(CHANNEL);
    useActiveThread.getState().clearActiveThread(CHAT);
    expect(useActiveThread.getState().thread).toEqual(CHANNEL);
  });

  it("clearing the CURRENT registration still blanks it", () => {
    useActiveThread.getState().setActiveThread(CHANNEL);
    useActiveThread.getState().clearActiveThread(CHANNEL);
    expect(useActiveThread.getState().thread).toBeNull();
  });
});
