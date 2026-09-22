import type { ClientPlatform } from "@taskboard/shared";
import { detectPlatform } from "./downloads";

/**
 * The OS this web/Electron renderer is running on, in the vocabulary /auth/login
 * takes. Electron's renderer is Chromium, so the same user-agent read covers the
 * desktop app; mobile builds do not use this (they read `Platform.OS`).
 *
 * `detectPlatform` already answers windows/mac/linux but deliberately returns
 * null for phones, so iOS and Android are picked out first. An iPad in desktop
 * mode reports itself as a Mac and is treated as one. Anything unrecognised is
 * "unknown", which the server treats as "CAPTCHA required".
 */
export function detectClientPlatform(): ClientPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (ua.includes("android")) return "android";
  switch (detectPlatform()) {
    case "windows":
      return "windows";
    case "mac":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}
