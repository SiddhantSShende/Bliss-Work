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

  it.each(["con", "CON.txt", "nul.tar.gz", "Aux", "com1.log", "LPT9.txt"])(
    "does not leave the Windows device name %j as a file name",
    (name) => {
      expect(sanitize(name)).toBe(`_${name}`);
    },
  );

  it("leaves names that merely start with a device name alone", () => {
    for (const name of ["console.log", "nullable.txt", "com10.txt", "auxiliary.pdf"]) {
      expect(sanitize(name)).toBe(name);
    }
  });

  it("caps an over-long name but keeps its extension, so the executable check still sees it", () => {
    const out = sanitize(`${"a".repeat(400)}.exe`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".exe")).toBe(true);
    expect(isExecutableAttachment(out)).toBe(true);
    expect(sanitize("b".repeat(400)).length).toBeLessThanOrEqual(200);
  });
});

describe("isExecutableAttachment", () => {
  it("flags executable and auto-mounting extensions, case-insensitively", () => {
    for (const name of ["a.exe", "a.EXE", "a.Msi", "a.ps1", "a.iso", "a.lnk"]) {
      expect(isExecutableAttachment(`/downloads/${name}`)).toBe(true);
    }
  });

  it.each([
    ".sh", ".command", ".app", ".pkg", ".dmg", ".desktop", ".AppImage", ".deb", ".rpm", ".jnlp", ".msix", ".appx",
    ".msp", ".gadget", ".scf", ".library-ms", ".xll", ".docm", ".xlsm", ".pptm", ".py", ".pl", ".terminal",
    ".workflow",
  ])("flags the launcher extension %s, so it is revealed rather than opened", (ext) => {
    expect(isExecutableAttachment(`/downloads/thing${ext}`)).toBe(true);
  });

  it("lets ordinary documents through", () => {
    for (const name of ["a.pdf", "a.png", "notes.txt", "archive.tar.gz", "a.docx", "a.xlsx", "a.pptx", "a.zip", "a.csv"]) {
      expect(isExecutableAttachment(`/downloads/${name}`)).toBe(false);
    }
  });
});
