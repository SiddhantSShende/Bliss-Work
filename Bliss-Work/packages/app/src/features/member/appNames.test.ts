import { describe, expect, it } from "vitest";
import { resolveAppName } from "./appNames";

describe("resolveAppName", () => {
  it.each([
    ["chrome.exe", "Google Chrome"],
    ["code.exe", "Visual Studio Code"],
    ["msedge.exe", "Microsoft Edge"],
    ["WINWORD.EXE", "Microsoft Word"],
    ["EXCEL.EXE", "Microsoft Excel"],
    ["Teams.exe", "Microsoft Teams"],
    ["explorer.exe", "File Explorer"],
  ])("names %s as %s", (exe, name) => {
    expect(resolveAppName(exe)).toBe(name);
  });

  it("matches a known executable by its file name, whatever the path or case", () => {
    expect(resolveAppName("C:\\Program Files\\Google\\Chrome\\Application\\Chrome.EXE")).toBe("Google Chrome");
  });

  describe("unknown executables", () => {
    it.each([
      ["slackhelper.exe", "Slackhelper"],
      ["WindowsTerminalPreview.exe", "Windows Terminal Preview"],
      ["my-cool_app.exe", "My Cool App"],
      ["vlc.exe", "Vlc"],
      ["SOFFICE.EXE", "Soffice"],
      ["iTunes.exe", "iTunes"],
      ["Some App.exe", "Some App"],
      ["tool", "Tool"],
    ])("turns %s into %s", (exe, name) => {
      expect(resolveAppName(exe)).toBe(name);
    });

    it("never leaves .exe on a readable name", () => {
      expect(resolveAppName("mystery.exe")).not.toMatch(/\.exe$/i);
    });

    it("keeps a short all-caps name as an acronym", () => {
      expect(resolveAppName("VLC.EXE")).toBe("VLC");
    });

    it("does not return an empty string for a name that is only an extension", () => {
      expect(resolveAppName(".exe")).toBe(".exe");
    });
  });
});
