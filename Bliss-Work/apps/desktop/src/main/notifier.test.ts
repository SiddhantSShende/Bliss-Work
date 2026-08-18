import { describe, expect, it } from "vitest";
import { popupFor, shouldNotify, userIdFromToken, type WindowState } from "./notifier";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

const win = (over: Partial<WindowState> = {}): WindowState => ({
  exists: true,
  visible: true,
  minimized: false,
  focused: true,
  ...over,
});

describe("shouldNotify", () => {
  it("stays quiet while the user is looking at the app", () => {
    expect(shouldNotify(win())).toBe(false);
  });

  it("notifies when the window was closed to the tray", () => {
    expect(shouldNotify(win({ visible: false, focused: false }))).toBe(true);
  });

  it("notifies when the window is minimized", () => {
    expect(shouldNotify(win({ minimized: true, focused: false }))).toBe(true);
  });

  it("notifies when the app is open but behind whatever the user is working in", () => {
    expect(shouldNotify(win({ focused: false }))).toBe(true);
  });

  it("notifies when there is no window at all", () => {
    expect(shouldNotify(win({ exists: false, visible: false, focused: false }))).toBe(true);
  });
});

describe("popupFor — direct messages", () => {
  const dm = (over: Record<string, unknown> = {}) => ({
    type: "message.created",
    senderId: THEM,
    recipientId: ME,
    body: "are you free at 3?",
    ...over,
  });

  it("announces a message from someone else", () => {
    expect(popupFor(dm(), ME)).toEqual({ title: "New message", body: "are you free at 3?" });
  });

  it("never announces the user's own message back at them", () => {
    // The gateway routes a DM to BOTH parties for multi-device sync, so this is
    // the ordinary case, not an edge one.
    expect(popupFor(dm({ senderId: ME }), ME)).toBeNull();
  });

  it("stays silent when no one is signed in", () => {
    expect(popupFor(dm(), null)).toBeNull();
  });

  it("strips the attachment envelope instead of printing raw JSON", () => {
    const body = `🖼️ photo.jpg · 2.0 MB${String.fromCharCode(0x1f)}{"v":2,"kind":"media","items":[]}`;
    expect(popupFor(dm({ body }), ME)?.body).toBe("🖼️ photo.jpg · 2.0 MB");
  });

  it("says something for a body that is nothing but an envelope", () => {
    expect(popupFor(dm({ body: `${String.fromCharCode(0x1f)}{"v":2}` }), ME)?.body).toBe(
      "Sent an attachment",
    );
  });

  it("truncates a very long message rather than letting the OS do it", () => {
    const got = popupFor(dm({ body: "x".repeat(500) }), ME);
    expect(got?.body.length).toBeLessThanOrEqual(180);
    expect(got?.body.endsWith("…")).toBe(true);
  });
});

describe("popupFor — channel messages", () => {
  const msg = (over: Record<string, unknown> = {}) => ({
    type: "channel.message.created",
    senderId: THEM,
    senderUsername: "j.okafor",
    senderDisplayName: "Jane Okafor",
    body: "shipping today",
    ...over,
  });

  it("titles the popup with the sender's name", () => {
    expect(popupFor(msg(), ME)).toEqual({ title: "Jane Okafor", body: "shipping today" });
  });

  it("falls back to the handle only when there is no name", () => {
    expect(popupFor(msg({ senderDisplayName: "" }), ME)?.title).toBe("j.okafor");
  });

  it("never announces the user's own channel message", () => {
    expect(popupFor(msg({ senderId: ME }), ME)).toBeNull();
  });
});

describe("popupFor — tasks", () => {
  it("announces an allocated task by its title", () => {
    const got = popupFor({ type: "task.assigned", title: "Ship the release notes" }, ME);
    expect(got).toEqual({ title: "New task", body: "Ship the release notes" });
  });

  it("still says something for a task with no title", () => {
    expect(popupFor({ type: "task.assigned", title: "" }, ME)?.body).toBe(
      "You were allocated a task",
    );
  });
});

describe("popupFor — added to a channel", () => {
  it("names the channel someone added you to", () => {
    const got = popupFor(
      { type: "channel.member.joined", userId: ME, actorId: THEM, channelName: "general" },
      ME,
    );
    expect(got).toEqual({ title: "Added to a channel", body: "You were added to #general" });
  });

  it("says nothing when you joined an open channel yourself", () => {
    expect(
      popupFor(
        { type: "channel.member.joined", userId: ME, actorId: ME, channelName: "general" },
        ME,
      ),
    ).toBeNull();
  });

  it("stays quiet for a producer that does not send actorId — it could be a self-join", () => {
    expect(
      popupFor({ type: "channel.member.joined", userId: ME, channelName: "general" }, ME),
    ).toBeNull();
  });

  it("degrades to a vaguer sentence when the channel name is missing", () => {
    const got = popupFor({ type: "channel.member.joined", userId: ME, actorId: THEM }, ME);
    expect(got?.body).toBe("You were added to a channel");
  });
});

describe("popupFor — everything else", () => {
  it.each([
    "message.read",
    "message.delivered",
    "message.reaction",
    "presence.online",
    "channel.message.reaction",
    "notification.created",
  ])("ignores %s — traffic, not news", (type) => {
    expect(popupFor({ type, senderId: THEM }, ME)).toBeNull();
  });

  it("ignores a non-object payload", () => {
    expect(popupFor(null, ME)).toBeNull();
    expect(popupFor("message.created", ME)).toBeNull();
  });
});

describe("userIdFromToken", () => {
  const jwt = (claims: object) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("reads the sub claim", () => {
    expect(userIdFromToken(jwt({ sub: ME, org_id: "x" }))).toBe(ME);
  });

  it("returns null for a signed-out app", () => {
    expect(userIdFromToken(null)).toBeNull();
  });

  it("returns null rather than throwing on anything unreadable", () => {
    expect(userIdFromToken("not-a-jwt")).toBeNull();
    expect(userIdFromToken("header..sig")).toBeNull();
    expect(userIdFromToken("header.bm90LWpzb24.sig")).toBeNull();
    expect(userIdFromToken(jwt({ org_id: "x" }))).toBeNull();
  });
});
