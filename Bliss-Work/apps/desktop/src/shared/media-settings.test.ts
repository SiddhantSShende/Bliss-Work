/**
 * The OS camera/microphone-settings deep links, per platform — mirrors
 * location-settings.test.ts. The load-bearing property is the same one:
 * this map NEVER grows a way to open a caller-supplied URL (see that file's
 * own doc comment on why), and a test walking the exported surface is what
 * makes that assumption break loudly if someone later parameterizes it.
 */
import { describe, expect, it } from "vitest";
import { hasMediaSettingsPage, mediaSettingsUrl } from "./media-settings";

describe("mediaSettingsUrl", () => {
  it("points Windows at the webcam/microphone privacy pages", () => {
    expect(mediaSettingsUrl("camera", "win32")).toBe("ms-settings:privacy-webcam");
    expect(mediaSettingsUrl("microphone", "win32")).toBe("ms-settings:privacy-microphone");
  });

  it("points macOS at the Camera/Microphone privacy panes", () => {
    expect(mediaSettingsUrl("camera", "darwin")).toContain("Privacy_Camera");
    expect(mediaSettingsUrl("microphone", "darwin")).toContain("Privacy_Microphone");
  });

  it("has nothing to open on Linux, which has no such OS page", () => {
    expect(mediaSettingsUrl("camera", "linux")).toBeNull();
    expect(mediaSettingsUrl("microphone", "linux")).toBeNull();
    expect(hasMediaSettingsPage("camera", "linux")).toBe(false);
    expect(hasMediaSettingsPage("microphone", "linux")).toBe(false);
  });

  it("treats an unknown platform as having no page", () => {
    expect(mediaSettingsUrl("camera", "aix" as NodeJS.Platform)).toBeNull();
  });

  it("only ever yields the four fixed constants", () => {
    const platforms: NodeJS.Platform[] = [
      "aix", "android", "cygwin", "darwin", "freebsd", "haiku",
      "linux", "netbsd", "openbsd", "sunos", "win32",
    ];
    const urls = platforms
      .flatMap((p) => [mediaSettingsUrl("camera", p), mediaSettingsUrl("microphone", p)])
      .filter((u): u is string => u !== null);
    expect(new Set(urls)).toEqual(
      new Set([
        "ms-settings:privacy-webcam",
        "ms-settings:privacy-microphone",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      ]),
    );
  });
});
