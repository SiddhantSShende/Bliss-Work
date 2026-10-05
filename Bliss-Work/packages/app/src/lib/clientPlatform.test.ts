import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientPlatform } from "@taskboard/shared";
import { UA } from "../test/userAgents";
import { detectClientPlatform } from "./clientPlatform";

const setUserAgent = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { userAgentData?: unknown }).userAgentData;
});

describe("detectClientPlatform", () => {
  it.each<[string, string, ClientPlatform]>([
    ["macOS browser", UA.macBrowser, "macos"],
    ["macOS Electron app", UA.macElectron, "macos"],
    ["iOS", UA.iphone, "ios"],
    ["Windows browser", UA.windows, "windows"],
    ["Windows Electron app", UA.windowsElectron, "windows"],
    ["Linux", UA.linux, "linux"],
    ["Android", UA.android, "android"],
    ["something unrecognised", UA.unknown, "unknown"],
  ])("%s → %s", (_label, ua, expected) => {
    setUserAgent(ua);
    expect(detectClientPlatform()).toBe(expected);
  });

  it("reads Chromium's userAgentData platform for the Electron app", () => {
    setUserAgent(UA.macElectron);
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" }, configurable: true });
    expect(detectClientPlatform()).toBe("macos");
  });

  it("does not mistake an iPhone's 'like Mac OS X' for a Mac", () => {
    setUserAgent(UA.iphone);
    expect(detectClientPlatform()).toBe("ios");
  });

  it("does not mistake Android's 'Linux' for desktop Linux", () => {
    setUserAgent(UA.android);
    expect(detectClientPlatform()).toBe("android");
  });
});
