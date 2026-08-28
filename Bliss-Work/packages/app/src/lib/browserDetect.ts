/**
 * Which browser family this tab is running in, and whether THIS deployment's
 * extension can be auto-detected/auto-provisioned there at all.
 *
 * Deliberately narrow: a user-agent sniff is inherently best-effort (spoofable,
 * and every Chromium fork's UA still contains "Chrome"), so this is used only
 * to pick which install link/copy to show — never to grant or withhold
 * anything security-sensitive. The real capability check is always whether
 * `chrome.runtime` exists (see extensionProvisioning.ts's `chromeRuntime()`).
 */
export type BrowserFamily = "chrome" | "edge" | "brave" | "firefox" | "safari" | "unknown";

/**
 * Order matters: Edge and Brave both carry "Chrome" in their UA (they ARE
 * Chromium), so their own markers must be checked first. Brave has no unique
 * UA token by design (part of its fingerprinting resistance) — detected via
 * `navigator.brave` where available, which is Brave's own supported API for
 * this, not a hack.
 */
export function detectBrowserFamily(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
  hasBraveApi: boolean =
    typeof navigator !== "undefined" && "brave" in navigator && typeof (navigator as { brave?: unknown }).brave === "object",
): BrowserFamily {
  if (hasBraveApi) return "brave";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  // Chrome's own UA also matches Safari's "Safari/" token, so Safari must be
  // checked only once Chrome/Chromium tokens are ruled out.
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "unknown";
}

/**
 * Whether THIS extension build supports the automatic ping/provision
 * handshake (`extensionProvisioning.ts`) for a browser family at all — not
 * just "did this deployment configure an id for it".
 *
 * Chrome/Edge/Brave only: `apps/extension/manifest.json` (the Chromium build,
 * shared by all three) is the only one declaring `externally_connectable`.
 * `manifest.firefox.json` and `manifest.safari.json` do not, by manifest
 * design — `chrome.runtime.sendMessage(extensionId, ...)` cannot reach the
 * extension there no matter what id is configured. Claiming support for those
 * two here would be exactly the "fake support" this integration must avoid.
 */
export function supportsAutoExtensionIntegration(family: BrowserFamily): boolean {
  return family === "chrome" || family === "edge" || family === "brave";
}
