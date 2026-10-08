import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: {}, app: {}, BrowserWindow: {}, globalShortcut: {} }));

import { isPermissionGranted, requesterUrl } from "./permissions";

// harden.ts resolves "own renderer files" relative to itself: src/renderer/ here.
const OWN = (name: string) => pathToFileURL(join(__dirname, "../renderer", name)).href;
const allowed = new Set(["media", "geolocation", "notifications"]);
const granted = (perm: string, url: string) => isPermissionGranted(allowed, perm, url);

describe("isPermissionGranted", () => {
  it.each([
    ["the main window", OWN("index.html")],
    ["a meeting window (query string)", `${OWN("index.html")}?callId=abc`],
    ["a sticky note", `${OWN("sticky.html")}?taskId=1`],
    ["the pinned-chat window", `${OWN("sticky-chat.html")}?threadId=1`],
    ["the invite popup", OWN("meeting-invite.html")],
  ])("still grants media to %s", (_n, url) => {
    expect(granted("media", url)).toBe(true);
    expect(granted("geolocation", url)).toBe(true);
  });

  it.each([
    ["a blob: preview frame", "blob:file:///158fc076-5f95-4ec1-b149-5681ec6f4583"],
    ["a srcdoc frame", "about:srcdoc"],
    ["a remote page", "https://evil.example/"],
    ["a file outside the renderer dir", "file:///etc/passwd"],
    ["an unknown requester", ""],
  ])("refuses %s", (_n, url) => {
    expect(granted("media", url)).toBe(false);
  });

  it("still refuses permissions that were never on the allowlist, for our own pages too", () => {
    expect(granted("clipboard-read", OWN("index.html"))).toBe(false);
  });
});

describe("requesterUrl", () => {
  it("uses the requesting frame's own URL when Electron supplies it", () => {
    expect(requesterUrl({ requestingUrl: "about:srcdoc", isMainFrame: false }, OWN("index.html"))).toBe("about:srcdoc");
  });

  it("falls back to the top frame's URL for a main-frame check that carries none", () => {
    expect(requesterUrl({ requestingUrl: "", isMainFrame: true }, OWN("index.html"))).toBe(OWN("index.html"));
  });

  it("falls back to embeddingOrigin when the web contents has no URL yet (still committing)", () => {
    expect(requesterUrl({ requestingUrl: "", isMainFrame: true, embeddingOrigin: OWN("index.html") }, "")).toBe(
      OWN("index.html"),
    );
  });

  it("does NOT lend a sub-frame the top frame's URL", () => {
    expect(requesterUrl({ requestingUrl: "", isMainFrame: false }, OWN("index.html"))).toBe("");
    expect(granted("media", requesterUrl({ requestingUrl: "", isMainFrame: false }, OWN("index.html")))).toBe(false);
  });

  it("is empty with no details and no web contents", () => {
    expect(requesterUrl(undefined, undefined)).toBe("");
  });
});

describe("session wiring", () => {
  // index.ts boots Electron on import, so the registration itself is pinned
  // structurally: both session handlers must go through isPermissionGranted.
  const source = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("answers both permission handlers through the requester check, never by permission name alone", () => {
    expect(source).not.toMatch(/cb\(allowed\.has\(permission\)\)/);
    expect(source).not.toMatch(/setPermissionCheckHandler\([^)]*\)\s*=>\s*allowed\.has/);
    expect(source).toMatch(/setPermissionRequestHandler[\s\S]{0,200}isPermissionGranted\(allowed/);
    expect(source).toMatch(/setPermissionCheckHandler[\s\S]{0,200}isPermissionGranted\(allowed/);
  });
});
