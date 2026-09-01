import { describe, expect, it } from "vitest";
import { decideInviteAction, type InviteBookkeeping } from "./meeting-invite-manager";

const book = (over: Partial<InviteBookkeeping> = {}): InviteBookkeeping => ({
  current: null,
  announced: new Set(),
  ...over,
});

describe("decideInviteAction", () => {
  it("opens a fresh invite nobody has seen before", () => {
    expect(decideInviteAction(book(), "call-1")).toBe("open");
  });

  it("updates the SAME invite already on screen, instead of opening a second window", () => {
    expect(decideInviteAction(book({ current: "call-1" }), "call-1")).toBe("update");
  });

  it("ignores a callId already shown and since dismissed — the 'one popup, ever' rule", () => {
    // Dismissing clears `current` but NOT `announced` — see the class's own
    // doc comment for why a later event for this same call must not bring
    // the popup back.
    expect(decideInviteAction(book({ current: null, announced: new Set(["call-1"]) }), "call-1")).toBe(
      "ignore",
    );
  });

  it("opens a genuinely different call even while one is already showing", () => {
    expect(decideInviteAction(book({ current: "call-1", announced: new Set(["call-1"]) }), "call-2")).toBe(
      "open",
    );
  });

  it("opens a different call even though some OTHER call was announced before", () => {
    expect(decideInviteAction(book({ announced: new Set(["call-1"]) }), "call-2")).toBe("open");
  });
});
