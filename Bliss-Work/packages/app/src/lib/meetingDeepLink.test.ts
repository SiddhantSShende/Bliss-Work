import { describe, expect, it } from "vitest";
import { meetingDeepLink, meetingJoinUrl } from "./meetingDeepLink";

describe("meetingJoinUrl", () => {
  it("builds the https join link from the given base, never from window.location", () => {
    expect(meetingJoinUrl("https://communication.rnrtechs.com", "abc123")).toBe(
      "https://communication.rnrtechs.com/join?t=abc123",
    );
  });

  it("encodes the token", () => {
    expect(meetingJoinUrl("https://app.test", "a b/c")).toBe("https://app.test/join?t=a%20b%2Fc");
  });
});

describe("meetingDeepLink", () => {
  it("builds the taskboard:// scheme the https join page hands off to", () => {
    expect(meetingDeepLink("abc123")).toBe("taskboard://join?t=abc123");
  });
});
