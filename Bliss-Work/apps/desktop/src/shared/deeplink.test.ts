/**
 * Deep-link routing.
 *
 * These strings reach us from the OS — via `open-url`, `second-instance` argv,
 * or `process.argv` on a cold start — so they are untrusted input arriving on a
 * path the user did not consciously choose. Two kinds are handled: the
 * emailed invite link and a meeting join link.
 */
import { describe, it, expect } from "vitest";
import { parseDeepLink, findDeepLink } from "./deeplink";

describe("parseDeepLink", () => {
  it("routes an emailed invite", () => {
    expect(parseDeepLink("taskboard://invite?token=abc123")).toEqual({
      kind: "invite",
      token: "abc123",
    });
  });

  it("routes an invite regardless of host", () => {
    // Links already sitting in users' inboxes don't all carry a consistent
    // host, so the invite branch keys off the token param.
    expect(parseDeepLink("taskboard://app/accept?token=xyz")).toEqual({
      kind: "invite",
      token: "xyz",
    });
  });

  it("url-decodes token values", () => {
    expect(parseDeepLink("taskboard://invite?token=a%2Bb%2Fc")).toEqual({
      kind: "invite",
      token: "a+b/c",
    });
  });

  it("routes a meeting join link", () => {
    expect(parseDeepLink("taskboard://join?t=abc123")).toEqual({
      kind: "meeting",
      token: "abc123",
    });
  });

  it("url-decodes a meeting token", () => {
    expect(parseDeepLink("taskboard://join?t=a%2Bb%2Fc")).toEqual({
      kind: "meeting",
      token: "a+b/c",
    });
  });

  it("accepts the join host in pathname form", () => {
    const viaPath = parseDeepLink("taskboard:///join?t=xyz");
    expect(viaPath).toEqual({ kind: "meeting", token: "xyz" });
  });

  it.each([
    // THE security case: without a scheme check, any URL in argv carrying a
    // `token` param would be treated as an invite — including one an attacker
    // planted in a desktop shortcut's arguments.
    ["https://evil.example/?token=stolen", "https with a token param"],
    ["file:///tmp/x?token=abc", "file with a token param"],
    ["javascript:void(0)?token=abc", "javascript"],
    ["taskboardx://invite?token=abc", "look-alike scheme"],
    // Same case for the join/meeting branch and its `t` param.
    ["https://evil.example/join?t=stolen", "https join host with a t param"],
  ])("ignores %s (%s)", (input, _label) => {
    expect(parseDeepLink(input)).toBeNull();
  });

  it.each([
    [undefined, "undefined"],
    [null, "null"],
    ["", "empty"],
    ["not a url", "unparseable"],
    ["taskboard://something-else", "known scheme, no route"],
    ["taskboard://invite", "invite with no token"],
    ["taskboard://invite?token=", "invite with an empty token"],
    ["taskboard://join", "join with no token"],
    ["taskboard://join?t=", "join with an empty token"],
  ])("returns null for %s (%s)", (input, _label) => {
    expect(parseDeepLink(input)).toBeNull();
  });
});

describe("findDeepLink", () => {
  it("finds the link among real launch arguments", () => {
    // What a Windows cold start actually looks like.
    const argv = [
      "C:\\Users\\x\\AppData\\Local\\Programs\\BlissWork\\BlissWork.exe",
      "--allow-file-access-from-files",
      "taskboard://invite?token=abc123",
    ];
    expect(findDeepLink(argv)).toBe("taskboard://invite?token=abc123");
  });

  it("returns undefined for an ordinary launch", () => {
    expect(findDeepLink(["/usr/bin/blisswork", "--auto-start"])).toBeUndefined();
  });

  it("returns undefined for an empty argv", () => {
    expect(findDeepLink([])).toBeUndefined();
  });

  it("returns the first link when several are present", () => {
    const argv = ["app.exe", "taskboard://invite?token=a", "taskboard://invite?token=b"];
    expect(findDeepLink(argv)).toBe("taskboard://invite?token=a");
  });
});
