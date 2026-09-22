/**
 * The desktop opens a downloaded attachment with the OS default app UNLESS its
 * extension is executable-class, in which case it only reveals it. The extension
 * came from `extname()` of the sanitized name, and the sanitizer left names Windows
 * normalizes differently from Node: "evil.exe." (Windows drops the trailing dot) had
 * no extension as far as the check could tell, so it was opened — and run.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/downloads" },
  ipcMain: { handle: vi.fn() },
  shell: {},
}));

import { isExecutableAttachment, sanitize } from "./attachment-open";

describe("sanitize", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["../../etc/passwd", "_.._etc_passwd"],
    ["C:\\Windows\\evil.exe", "C__Windows_evil.exe"],
    ["..hidden.txt", "hidden.txt"],
    ["  padded.txt  ", "padded.txt"],
    ["", "download"],
    ["...", "download"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });

  it.each(["evil.exe.", "evil.exe..", "evil.exe. ", "evil.exe .", "evil.exe   "])(
    "leaves no trailing dot or space on %j, so the real extension is what gets checked",
    (name) => {
      expect(sanitize(name)).toBe("evil.exe");
      expect(isExecutableAttachment(sanitize(name))).toBe(true);
    },
  );

  it("does not let a colon address an alternate data stream", () => {
    expect(sanitize("photo.jpg:evil.exe")).not.toContain(":");
    expect(isExecutableAttachment(sanitize("x.exe:payload"))).toBe(false); // "x.exe_payload" is inert
  });

  it("strips control characters", () => {
    expect(sanitize("a\u0000b\nc.txt")).toBe("a_b_c.txt");
  });
});

describe("isExecutableAttachment", () => {
  it("flags executable and auto-mounting extensions, case-insensitively", () => {
    for (const name of ["a.exe", "a.EXE", "a.Msi", "a.ps1", "a.iso", "a.lnk"]) {
      expect(isExecutableAttachment(`/downloads/${name}`)).toBe(true);
    }
  });

  it("lets ordinary documents through", () => {
    for (const name of ["a.pdf", "a.png", "notes.txt", "archive.tar.gz"]) {
      expect(isExecutableAttachment(`/downloads/${name}`)).toBe(false);
    }
  });
});
