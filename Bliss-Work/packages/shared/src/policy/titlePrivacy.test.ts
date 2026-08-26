import { describe, expect, it } from "vitest";
import { filterTitle, isSensitiveApp, isSensitiveTitle } from "./titlePrivacy";

describe("sensitive applications never keep a title", () => {
  it("recognises known password managers by their resolved name", () => {
    expect(isSensitiveApp("1Password")).toBe(true);
    expect(isSensitiveApp("Bitwarden")).toBe(true);
    expect(isSensitiveApp("LastPass")).toBe(true);
  });

  it("does not flag an ordinary application", () => {
    expect(isSensitiveApp("Google Chrome")).toBe(false);
    expect(isSensitiveApp("Visual Studio Code")).toBe(false);
    expect(isSensitiveApp(null)).toBe(false);
    expect(isSensitiveApp(undefined)).toBe(false);
  });

  it("recognises a password manager regardless of casing", () => {
    // None of these names are in activityDestination.ts's APP_NAMES map, so
    // resolveApp passes an unmapped app's OS-reported casing straight
    // through (e.g. lower-case on Linux) — isSensitiveApp must not assume
    // resolveApp already normalised it.
    expect(isSensitiveApp("1password")).toBe(true);
    expect(isSensitiveApp("BITWARDEN")).toBe(true);
    expect(isSensitiveApp("keepassxc")).toBe(true);
    expect(isSensitiveApp("Proton Pass")).toBe(true);
  });
});

describe("sensitive title text is withheld regardless of application", () => {
  it("matches on revealing keywords, case-insensitively", () => {
    expect(isSensitiveTitle("Your one-time code is 481223")).toBe(true);
    expect(isSensitiveTitle("VERIFICATION CODE — Chase")).toBe(true);
    expect(isSensitiveTitle("Re: your bank statement is ready")).toBe(true);
    expect(isSensitiveTitle("Patient portal — lab results")).toBe(true);
  });

  it("does not flag ordinary titles", () => {
    expect(isSensitiveTitle("Learn Go in 30 Minutes - YouTube")).toBe(false);
    expect(isSensitiveTitle("activity.go - BlissWork - Visual Studio Code")).toBe(false);
  });

  it("treats an absent title as not sensitive (nothing to withhold)", () => {
    expect(isSensitiveTitle(null)).toBe(false);
    expect(isSensitiveTitle(undefined)).toBe(false);
    expect(isSensitiveTitle("")).toBe(false);
  });
});

describe("filterTitle — the floor activity-agent.ts actually calls", () => {
  it("passes an ordinary title through unchanged", () => {
    expect(filterTitle("Google Chrome", "Learn Go in 30 Minutes - YouTube")).toBe(
      "Learn Go in 30 Minutes - YouTube",
    );
  });

  it("withholds every title from a sensitive application, however innocuous", () => {
    expect(filterTitle("1Password", "example.com – Login")).toBeNull();
    expect(filterTitle("Bitwarden", "Vault unlocked")).toBeNull();
  });

  it("withholds a revealing title from an ordinary application", () => {
    expect(filterTitle("Mail", "Re: your one-time code is 481223")).toBeNull();
    expect(filterTitle("Google Chrome", "Password reset — Acme Corp")).toBeNull();
  });

  it("passes null/absent titles through as null, not as an error", () => {
    expect(filterTitle("Google Chrome", null)).toBeNull();
    expect(filterTitle("Google Chrome", undefined)).toBeNull();
  });

  it("is never overridden — no captureAll-equivalent escape hatch exists", () => {
    // Unlike NEVER_RECORD (which the extension can dial back via captureAll),
    // filterTitle takes no configuration argument at all: there is no legitimate
    // monitoring use for a password manager's title or a verification code.
    expect(filterTitle.length).toBe(2);
  });
});
