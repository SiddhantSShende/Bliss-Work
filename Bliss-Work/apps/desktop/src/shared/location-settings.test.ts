/**
 * The OS location-settings deep link, per platform.
 *
 * Two things are pinned here, and the second is the one that matters. The first
 * is that Windows and macOS resolve to their real settings pages. The second is
 * that this map NEVER grows a way to open a caller-supplied URL: `ms-settings:`
 * is in the same Windows scheme family that external-url.ts refuses outright
 * (`ms-msdt:`, `search-ms:`, `ms-officecmd:` have all carried RCE chains), and
 * the only reason opening it is safe is that the string is a constant chosen by
 * main from a closed set. A test that walks the exported surface is what makes
 * that assumption break loudly if someone later parameterizes it.
 */
import { describe, expect, it } from "vitest";
import { hasLocationSettingsPage, locationSettingsUrl } from "./location-settings";

describe("locationSettingsUrl", () => {
  it("points Windows at the location privacy page", () => {
    expect(locationSettingsUrl("win32")).toBe("ms-settings:privacy-location");
  });

  it("points macOS at Location Services", () => {
    expect(locationSettingsUrl("darwin")).toContain("Privacy_LocationServices");
  });

  it("has nothing to open on Linux, which has no OS location provider", () => {
    // Null rather than a best-effort guess: the caller drops the affordance,
    // so a Linux user sees no button instead of one that does nothing.
    expect(locationSettingsUrl("linux")).toBeNull();
    expect(hasLocationSettingsPage("linux")).toBe(false);
  });

  it("treats an unknown platform as having no page", () => {
    expect(locationSettingsUrl("aix" as NodeJS.Platform)).toBeNull();
  });

  it("only ever yields the two fixed constants", () => {
    // The security property, stated as a test: every reachable value is one of
    // these. If this fails, someone made the URL dynamic — re-read the note in
    // location-settings.ts before changing the expectation.
    const platforms: NodeJS.Platform[] = [
      "aix", "android", "cygwin", "darwin", "freebsd", "haiku",
      "linux", "netbsd", "openbsd", "sunos", "win32",
    ];
    const urls = platforms.map(locationSettingsUrl).filter((u): u is string => u !== null);
    expect(new Set(urls)).toEqual(
      new Set([
        "ms-settings:privacy-location",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
      ]),
    );
  });
});
