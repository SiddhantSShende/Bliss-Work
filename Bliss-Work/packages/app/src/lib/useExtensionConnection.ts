import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "./runtime";
import { getOrCreateBrowserDeviceKey, pingExtension, provisionExtension } from "./extensionProvisioning";

/**
 * The browser extension's connection state, as far as THIS tab can tell.
 *
 *  - "checking"      a ping is in flight (initial load, or a manual recheck).
 *  - "unsupported"   no `chrome.runtime` here, or this deployment has no
 *                     `chromeExtensionId` configured — see its doc comment.
 *  - "not-installed" the runtime exists and an id is configured, but the
 *                     extension didn't answer (not installed, or this origin
 *                     isn't in its `externally_connectable` list).
 *  - "connecting"    the extension answered, holds no token yet, and
 *                     autoProvision is on — a mint-and-pair round trip is in
 *                     flight. Kept distinct from "checking" (the ping alone)
 *                     so a caller can show "Connecting…" rather than
 *                     "Detecting…" for what is actually the slower half.
 *  - "installed"     the extension answered but holds no token yet — present,
 *                     not yet paired to an account, and either autoProvision
 *                     was off or the attempt (the "connecting" phase above)
 *                     failed.
 *  - "connected"     the extension ALREADY held a live token when pinged.
 *  - "provisioned"   this hook just finished pairing it (freshly connected,
 *                     not merely found already-connected) — kept distinct
 *                     from "connected" because callers show different copy
 *                     for the two ("connected" vs. "just now connected").
 */
export type ExtensionConnectionStatus =
  | "checking"
  | "unsupported"
  | "not-installed"
  | "connecting"
  | "installed"
  | "connected"
  | "provisioned";

/**
 * Shared status/handshake logic behind every surface that shows "is the
 * browser extension connected" — originally inline in ConnectedAgents.tsx,
 * pulled out here so the sign-in page CTA and the post-login auto-provision
 * bridge use the exact same protocol calls instead of a second copy of them.
 *
 * `autoProvision: false` is what makes this safe to run BEFORE sign-in (the
 * Login page): minting a token calls `api.createAgentToken`, a
 * session-authenticated endpoint (see `ApiClient.req`) — there is no session
 * yet on that page. Detection alone (the ping) needs no auth at all, since
 * `chrome.runtime.sendMessage` never leaves the browser.
 */
export function useExtensionConnection(autoProvision: boolean) {
  const { api, config } = useRuntime();
  const [status, setStatus] = useState<ExtensionConnectionStatus>("checking");
  // Guards every `setStatus` after an await, not just the outer call — the
  // same shape ConnectedAgents.tsx's own effect used before this was pulled
  // out, so a fast unmount (route change mid-ping) can never write into a
  // gone component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const check = useCallback(async () => {
    const extensionId = config.chromeExtensionId;
    if (!extensionId) {
      setStatus("unsupported");
      return;
    }
    setStatus("checking");
    const ping = await pingExtension(extensionId);
    if (cancelledRef.current) return;
    if (!ping) {
      setStatus("not-installed");
      return;
    }
    if (ping.connected) {
      setStatus("connected");
      return;
    }
    if (!autoProvision) {
      setStatus("installed");
      return;
    }
    setStatus("connecting");
    try {
      const deviceKey = getOrCreateBrowserDeviceKey();
      const created = await api.createAgentToken("extension", "Browser extension", deviceKey);
      if (cancelledRef.current) return;
      if (!created.token) {
        setStatus("installed"); // lost a double-submit race; the manual/next-check path still works
        return;
      }
      const result = await provisionExtension(extensionId, created.token, config.telemetryBase);
      if (cancelledRef.current) return;
      setStatus(result.ok ? "provisioned" : "installed");
    } catch {
      if (!cancelledRef.current) setStatus("installed");
    }
  }, [config, api, autoProvision]);

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.chromeExtensionId, autoProvision]);

  return { status, recheck: check };
}
