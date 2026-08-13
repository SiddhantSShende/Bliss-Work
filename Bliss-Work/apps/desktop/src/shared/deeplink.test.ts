/**
 * Deep-link routing.
 *
 * These strings reach us from the OS — via `open-url`, `second-instance` argv,
 * or `process.argv` on a cold start — so they are untrusted input arriving on a
 * path the user did not consciously choose. The two that matter operationally
 * are the emailed invite link and the OAuth return.
 */
import { describe, it, expect } from "vitest";
import { parseDeepLink, findDeepLink } from "./deeplink";

describe("parseDeepLink", () => {
  it("routes an OAuth return", () => {
    expect(parseDeepLink("taskboard://oauth?connected=gmail")).toEqual({
      kind: "oauth",
      connected: "gmail",
      error: undefined,
    });
  });

  it("routes an OAuth failure", () => {
    expect(parseDeepLink("taskboard://oauth?error=access_denied")).toEqual({
      kind: "oauth",
      connected: undefined,
      error: "access_denied",
    });
  });

  it("accepts the host in pathname form", () => {
    // Custom schemes are opaque to the WHATWG parser, so depending on platform
    // and how the OS handed us the string the host may land in `pathname`
    // instead of `hostname`. Both must route identically.
    const viaPath = parseDeepLink("taskboard:///oauth?connected=slack");
    expect(viaPath).toMatchObject({ kind: "oauth", connected: "slack" });
  });

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

  it.each([
    // THE security case: without a scheme check, any URL in argv carrying a
    // `token` param would be treated as an invite — including one an attacker
    // planted in a desktop shortcut's arguments.
    ["https://evil.example/?token=stolen", "https with a token param"],
    ["file:///tmp/x?token=abc", "file with a token param"],
    ["javascript:void(0)?token=abc", "javascript"],
    ["taskboardx://oauth?connected=gmail", "look-alike scheme"],
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
      "taskboard://oauth?connected=gmail",
    ];
    expect(findDeepLink(argv)).toBe("taskboard://oauth?connected=gmail");
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
