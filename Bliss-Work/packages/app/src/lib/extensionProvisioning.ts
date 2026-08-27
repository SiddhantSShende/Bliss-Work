/**
 * Detect and auto-provision the BlissWork browser extension from the web app,
 * via `chrome.runtime.sendMessage(extensionId, ...)` — the officially
 * supported mechanism for a page to message an extension it owns, gated by
 * that extension's `externally_connectable.matches` manifest entry. No
 * fingerprinting, no workaround: Chrome only delivers these messages from an
 * origin the extension's own manifest lists.
 *
 * Every function here resolves `null`/a failure shape rather than throwing
 * whenever the mechanism simply isn't available — no `chrome` global (not
 * Chrome/Chromium), no configured extension id (see `chromeExtensionId`'s own
 * doc comment on `PlatformConfig` for why that can be unset today), or the
 * extension not installed/reachable. Every caller's fallback is today's
 * existing manual connect flow, unchanged.
 */

interface ChromeRuntimeLike {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => void;
  lastError?: { message?: string } | null;
}

function chromeRuntime(): ChromeRuntimeLike | null {
  const c = (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome;
  return c?.runtime?.sendMessage ? c.runtime : null;
}

function sendToExtension(extensionId: string, message: unknown): Promise<unknown | null> {
  const runtime = chromeRuntime();
  if (!runtime) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      runtime.sendMessage(extensionId, message, (response) => {
        // lastError is Chrome's async-callback error channel (no extension at
        // that id, or the calling origin isn't in externally_connectable) —
        // reading it is required to prevent an "Unchecked runtime.lastError"
        // console warning even when the result is otherwise ignored.
        resolve(runtime.lastError || !response ? null : response);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function pingExtension(
  extensionId: string,
): Promise<{ connected: boolean; version: string } | null> {
  const res = await sendToExtension(extensionId, { type: "blisswork:ping" });
  return res as { connected: boolean; version: string } | null;
}

export type ExtensionProvisionResult =
  | { ok: true }
  | { ok: false; reason: "unreachable" | "invalid-token" | "bad-request" };

export async function provisionExtension(
  extensionId: string,
  token: string,
  apiBase: string,
): Promise<ExtensionProvisionResult> {
  const res = await sendToExtension(extensionId, { type: "blisswork:provision", token, apiBase });
  return (res as ExtensionProvisionResult | null) ?? { ok: false, reason: "unreachable" };
}

const BROWSER_DEVICE_KEY_STORAGE_KEY = "tb-browser-device-key";

/** A stable id for THIS browser profile, used the same way the desktop app's
 *  activity-state.ts deviceKey is: so a repeat auto-provision attempt (e.g.
 *  every login) asks telemetry-svc for "the token for this browser" instead
 *  of minting a fresh one each time. Plain localStorage, not a fingerprint —
 *  cleared if the person clears site data, which just means the next attempt
 *  mints one more token, the same cost a lost pairing already has today. */
export function getOrCreateBrowserDeviceKey(): string {
  try {
    const existing = localStorage.getItem(BROWSER_DEVICE_KEY_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(BROWSER_DEVICE_KEY_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Storage unavailable (private mode, policy-blocked): a fresh key every
    // call means auto-provisioning isn't idempotent for this profile — each
    // attempt mints its own token rather than reusing one — but it still
    // succeeds, and each of those tokens is individually visible and
    // revocable from Settings → Connected devices like any other.
    return crypto.randomUUID();
  }
}
