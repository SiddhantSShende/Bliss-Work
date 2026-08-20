import { describe, expect, it } from "vitest";
import {
  BLISSWORK_DESTINATION,
  isBlissWork,
  isBrowser,
  resolveApp,
  resolveDestination,
  resolveSite,
} from "./activityDestination";

describe("sites resolve to the name people call them", () => {
  it("maps the common destinations", () => {
    expect(resolveSite("youtube.com")).toBe("YouTube");
    expect(resolveSite("github.com")).toBe("GitHub");
    expect(resolveSite("google.com")).toBe("Google");
    expect(resolveSite("netflix.com")).toBe("Netflix");
  });

  it("folds a product's several domains onto one name", () => {
    // The whole reason this is a map and not a prettifier.
    expect(resolveSite("chatgpt.com")).toBe("ChatGPT");
    expect(resolveSite("chat.openai.com")).toBe("ChatGPT");
    expect(resolveSite("docs.google.com")).toBe("Google Docs");
    expect(resolveSite("mail.google.com")).toBe("Gmail");
  });

  it("normalises the forms the same site arrives in", () => {
    expect(resolveSite("www.youtube.com")).toBe("YouTube");
    expect(resolveSite("YouTube.com")).toBe("YouTube");
    expect(resolveSite("  youtube.com  ")).toBe("YouTube");
  });

  it("gives an unmapped site back unchanged rather than guessing", () => {
    // Requirement: accuracy over invention. A company domain IS the readable
    // answer; renaming it would be making something up.
    expect(resolveSite("example-company.com")).toBe("example-company.com");
    expect(resolveSite("internal.acme.co.uk")).toBe("internal.acme.co.uk");
  });
});

describe("applications resolve across the platforms' different spellings", () => {
  it("maps a Windows executable and a macOS bundle name to one result", () => {
    expect(resolveApp("Code.exe")).toBe("VS Code");
    expect(resolveApp("Visual Studio Code")).toBe("VS Code");
    expect(resolveApp("chrome.exe")).toBe("Google Chrome");
    expect(resolveApp("Google Chrome")).toBe("Google Chrome");
  });

  it("maps the Office and shell applications", () => {
    expect(resolveApp("WINWORD.EXE")).toBe("Microsoft Word");
    expect(resolveApp("OUTLOOK.EXE")).toBe("Outlook");
    expect(resolveApp("explorer.exe")).toBe("File Explorer");
    expect(resolveApp("Teams.exe")).toBe("Microsoft Teams");
    expect(resolveApp("slack.exe")).toBe("Slack");
  });

  it("keeps an unmapped application readable instead of discarding it", () => {
    // "Unknown Application" would throw away a real reading. The suffix goes,
    // the name stays.
    expect(resolveApp("Ledger.exe")).toBe("Ledger");
    expect(resolveApp("SomeInternalTool")).toBe("SomeInternalTool");
    // An all-caps executable would otherwise be shouted back at the reader.
    expect(resolveApp("PAYROLL.EXE")).toBe("Payroll");
  });

  it("returns null when the OS gave us nothing", () => {
    // The one case that must NOT be dressed up as a destination — the caller
    // renders it as "another application".
    expect(resolveApp(null)).toBeNull();
    expect(resolveApp("")).toBeNull();
    expect(resolveApp("   ")).toBeNull();
  });
});

describe("the BlissWork marker", () => {
  it("passes through whichever end it appears on", () => {
    expect(resolveDestination("site", BLISSWORK_DESTINATION)).toBe("BlissWork");
    expect(resolveDestination("app", BLISSWORK_DESTINATION)).toBe("BlissWork");
  });

  it("recognises the packaged app under the names each platform reports", () => {
    // The desktop agent's own foreground span is not the marker — it is
    // whatever the OS calls the build, and that differs per platform and
    // channel. Matching it is what makes "Came back to BlissWork" fire.
    expect(isBlissWork("BlissWork")).toBe(true);
    expect(isBlissWork("BlissWork.exe")).toBe(true);
    expect(isBlissWork("BlissWork Desktop")).toBe(true);
    expect(isBlissWork("blisswork")).toBe(true);
    expect(isBlissWork("Google Chrome")).toBe(false);
    expect(isBlissWork(null)).toBe(false);
  });
});

describe("browsers are marked as the coarse reading they are", () => {
  it("knows a browser from an application", () => {
    // "They were in Chrome" is true and nearly useless; the site row supersedes
    // it. Keyed on the RESOLVED name so one entry covers every spelling.
    expect(isBrowser(resolveApp("chrome.exe"))).toBe(true);
    expect(isBrowser(resolveApp("Google Chrome"))).toBe(true);
    expect(isBrowser(resolveApp("msedge.exe"))).toBe(true);
    expect(isBrowser(resolveApp("Code.exe"))).toBe(false);
    expect(isBrowser(resolveApp("OUTLOOK.EXE"))).toBe(false);
  });
});

describe("resolveDestination routes by the row's target kind", () => {
  it("reads the same string as a site or as an app depending on the kind", () => {
    expect(resolveDestination("site", "youtube.com")).toBe("YouTube");
    expect(resolveDestination("app", "Code.exe")).toBe("VS Code");
    // Unknown/absent kind falls to the application reading, which is the safe
    // one: it never invents a name.
    expect(resolveDestination(null, "Ledger.exe")).toBe("Ledger");
    expect(resolveDestination("site", null)).toBeNull();
  });
});
