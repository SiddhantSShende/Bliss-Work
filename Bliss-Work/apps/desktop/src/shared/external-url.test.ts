/**
 * The allowlist that decides what this app is willing to hand to the operating
 * system. Every case below is a URL a compromised or XSS'd renderer could try
 * to push through `window.open`, a link click, or the OAuth IPC.
 *
 * Worth stating plainly: `shell.openExternal` is not "open a web page". It is
 * "ask the OS to run whichever program registered this scheme". That is why the
 * blocked list here is longer and more paranoid than it looks.
 */
import { describe, it, expect } from "vitest";
import { safeExternalUrl } from "./external-url";

describe("safeExternalUrl", () => {
  it("allows ordinary https URLs", () => {
    expect(safeExternalUrl("https://communication.rnrtechs.com/app")).toBe(
      "https://communication.rnrtechs.com/app",
    );
  });

  it("preserves the query string OAuth depends on", () => {
    // The authorize URL carries state + PKCE params; dropping or reordering
    // them would break the flow.
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc&scope=a%20b";
    expect(safeExternalUrl(url)).toBe(url);
  });

  it.each([
    // Local-handler schemes; several of these have carried RCE chains on Windows.
    ["ms-msdt:/id PCWDiagnostic", "ms-msdt"],
    ["search-ms:query=x&crumb=location:\\\\evil\\share", "search-ms"],
    ["ms-officecmd:%7B%22id%22:3%7D", "ms-officecmd"],
    ["file:///etc/passwd", "file"],
    ["file://server/share/payload.exe", "file UNC"],
    // Script execution in whatever context the handler runs.
    ["javascript:alert(1)", "javascript"],
    ["data:text/html,<script>alert(1)</script>", "data"],
    ["vbscript:msgbox(1)", "vbscript"],
    // Plain http is a downgrade — every endpoint this app uses is TLS.
    ["http://communication.rnrtechs.com", "http"],
    // Our own scheme would re-enter the app's deep-link handling from outside.
    ["taskboard://oauth?connected=fake", "taskboard"],
    // SMB / share paths.
    ["\\\\evil\\share\\payload.exe", "UNC path"],
  ])("blocks %s (%s)", (input, _label) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it.each([
    ["", "empty string"],
    ["not a url", "unparseable"],
    ["/app/integrations", "relative path"],
    ["//evil.example", "protocol-relative"],
  ])("blocks %s (%s)", (input, _label) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it.each([
    [null, "null"],
    [undefined, "undefined"],
    [42, "number"],
    [{ toString: () => "https://ok.example" }, "object with a toString"],
    [["https://ok.example"], "array"],
  ])("blocks non-string input: %s (%s)", (input, _label) => {
    // IPC payloads are attacker-controlled shapes, not just strings. An object
    // whose toString() looks fine must not be coerced into passing.
    expect(safeExternalUrl(input)).toBeNull();
  });

  it("blocks URLs carrying embedded credentials", () => {
    // Classic phishing shape: the browser shows the host after the @.
    expect(safeExternalUrl("https://real.example@evil.example/")).toBeNull();
    expect(safeExternalUrl("https://user:pass@evil.example/")).toBeNull();
  });

  it("blocks absurdly long input before parsing it", () => {
    expect(safeExternalUrl(`https://x.example/${"a".repeat(4000)}`)).toBeNull();
  });

  it("is case-insensitive about the scheme", () => {
    // URL normalizes the protocol, so HTTPS: must pass and JAVASCRIPT: must not.
    expect(safeExternalUrl("HTTPS://example.com/")).toBe("https://example.com/");
    expect(safeExternalUrl("JavaScript:alert(1)")).toBeNull();
  });

  it("returns the re-serialized URL, not the raw input", () => {
    // What reaches the OS must be exactly what was validated — no gap between
    // the string we checked and the string we passed on.
    expect(safeExternalUrl("https://example.com")).toBe("https://example.com/");
  });
});
