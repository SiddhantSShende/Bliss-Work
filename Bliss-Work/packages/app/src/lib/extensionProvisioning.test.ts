import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateBrowserDeviceKey, pingExtension, provisionExtension } from "./extensionProvisioning";

/**
 * The web-app half of automatic extension provisioning:
 * chrome.runtime.sendMessage(extensionId, ...) is Chrome's own supported
 * mechanism for a page to message an extension it owns — these tests fake
 * only that one call, not a real browser.
 */

let sendMessage: ReturnType<typeof vi.fn>;
let lastError: { message?: string } | null;

function installFakeChromeRuntime(): void {
  lastError = null;
  sendMessage = vi.fn(
    (_id: string, _msg: unknown, cb: (r: unknown) => void) => {
      cb(pendingResponse);
    },
  );
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage,
      get lastError() {
        return lastError;
      },
    },
  };
}

let pendingResponse: unknown;

describe("extensionProvisioning", () => {
  beforeEach(() => {
    pendingResponse = undefined;
    localStorage.clear();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  describe("pingExtension", () => {
    it("resolves null when there is no chrome global at all (not a Chromium browser)", async () => {
      delete (globalThis as Record<string, unknown>).chrome;
      await expect(pingExtension("abc")).resolves.toBeNull();
    });

    it("resolves null when the extension is not installed (chrome.runtime.lastError)", async () => {
      installFakeChromeRuntime();
      lastError = { message: "Could not establish connection." };
      await expect(pingExtension("abc")).resolves.toBeNull();
    });

    it("resolves the response when the extension answers", async () => {
      installFakeChromeRuntime();
      pendingResponse = { connected: true, version: "1.0.0" };
      await expect(pingExtension("abc")).resolves.toEqual({ connected: true, version: "1.0.0" });
    });

    it("resolves not-connected when the extension answers but has no token", async () => {
      installFakeChromeRuntime();
      pendingResponse = { connected: false, version: "1.0.0" };
      await expect(pingExtension("abc")).resolves.toEqual({ connected: false, version: "1.0.0" });
    });
  });

  describe("provisionExtension", () => {
    it("returns unreachable when the extension cannot be reached", async () => {
      installFakeChromeRuntime();
      lastError = { message: "Could not establish connection." };
      await expect(provisionExtension("abc", "token", "https://api.test")).resolves.toEqual({
        ok: false, reason: "unreachable",
      });
    });

    it("forwards a 401-shaped rejection from the extension", async () => {
      installFakeChromeRuntime();
      pendingResponse = { ok: false, reason: "invalid-token" };
      await expect(provisionExtension("abc", "bad-token", "https://api.test")).resolves.toEqual({
        ok: false, reason: "invalid-token",
      });
    });

    it("returns ok when the extension confirms it stored the token", async () => {
      installFakeChromeRuntime();
      pendingResponse = { ok: true };
      await expect(provisionExtension("abc", "token", "https://api.test")).resolves.toEqual({ ok: true });
      expect(sendMessage).toHaveBeenCalledWith(
        "abc",
        { type: "blisswork:provision", token: "token", apiBase: "https://api.test" },
        expect.any(Function),
      );
    });
  });

  describe("getOrCreateBrowserDeviceKey", () => {
    it("is stable across calls in the same browser profile", () => {
      const a = getOrCreateBrowserDeviceKey();
      const b = getOrCreateBrowserDeviceKey();
      expect(a).toBe(b);
    });

    it("survives being read again after a fresh import (persisted, not module state)", () => {
      const first = getOrCreateBrowserDeviceKey();
      expect(localStorage.getItem("tb-browser-device-key")).toBe(first);
    });
  });
});
