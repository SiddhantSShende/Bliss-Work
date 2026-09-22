import { describe, expect, it } from "vitest";
import { CLIENT_PLATFORMS, isCaptchaExemptPlatform, type ClientPlatform } from "./clientPlatform";

describe("isCaptchaExemptPlatform", () => {
  it.each<ClientPlatform>(["macos", "ios"])("%s is not challenged", (platform) => {
    expect(isCaptchaExemptPlatform(platform)).toBe(true);
  });

  it.each<ClientPlatform>(["windows", "linux", "android", "unknown"])(
    "%s keeps the CAPTCHA",
    (platform) => {
      expect(isCaptchaExemptPlatform(platform)).toBe(false);
    },
  );

  it("keeps the CAPTCHA when the platform is not known at all", () => {
    expect(isCaptchaExemptPlatform(undefined)).toBe(false);
    expect(isCaptchaExemptPlatform(null)).toBe(false);
  });

  it("exempts exactly macOS and iOS out of every platform there is", () => {
    expect(CLIENT_PLATFORMS.filter(isCaptchaExemptPlatform)).toEqual(["macos", "ios"]);
  });
});
