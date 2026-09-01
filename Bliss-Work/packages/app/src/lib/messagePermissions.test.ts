import { describe, expect, it } from "vitest";
import { canDeleteForAll } from "./messagePermissions";

describe("canDeleteForAll", () => {
  it("allows the author to delete their own message", () => {
    expect(canDeleteForAll({ senderId: "me" }, "me")).toBe(true);
  });

  it("refuses someone else's message with no moderation flag", () => {
    expect(canDeleteForAll({ senderId: "them" }, "me")).toBe(false);
  });

  it("allows someone else's message when canModerate is true", () => {
    expect(canDeleteForAll({ senderId: "them" }, "me", true)).toBe(true);
  });

  it("never treats a message as the caller's own when meId is empty — a briefly missing session must not right-align/authorize as if it were mine", () => {
    expect(canDeleteForAll({ senderId: "" }, "")).toBe(false);
  });
});
