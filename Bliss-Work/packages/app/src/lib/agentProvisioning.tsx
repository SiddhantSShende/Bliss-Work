import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { deviceLabel } from "../features/DeviceActivitySettings";
import { useExtensionConnection } from "./useExtensionConnection";

/**
 * Auto-provision the desktop activity agent's PAIRING right after login —
 * never its CONSENT.
 *
 * Mints (or, via `deviceKey`, reuses) a pairing token and hands it to the
 * main process so the mechanism is ready to go; whether sampling actually
 * starts stays entirely gated by the person's own explicit choice in
 * Settings → Your activity (`DeviceActivitySettings.tsx`, `activity-
 * state.ts`'s `enabled`), which this never touches. Today that toggle is
 * only ever reached if someone happens to go looking for it — this closes
 * that gap on the PAIRING half without touching the consent half at all.
 *
 * Renders nothing. Absent on web (`config.activityAgent` is undefined there
 * — a browser cannot observe other applications). A no-op once already
 * paired, so re-running on every remount/refresh costs one IPC round trip
 * and nothing else.
 */
export function AgentProvisioningBridge() {
  const { api, config } = useRuntime();
  const status = useSession((s) => s.status);

  useEffect(() => {
    const agent = config.activityAgent;
    if (!agent || status !== "authed") return;
    let cancelled = false;
    void (async () => {
      const state = await agent.state();
      if (cancelled || !state || state.paired) return;

      let minted: { id: string; kind: string; token: string | null };
      try {
        minted = await api.createAgentToken("desktop", deviceLabel(), state.deviceKey);
      } catch {
        // Handled gracefully: nothing is paired, nothing is ever reported as
        // tracking, and the ordinary manual "Connect" flow in Settings is
        // untouched — this is a background convenience, not the only path.
        return;
      }
      if (cancelled) return;

      if (!minted.token) {
        // get-or-create found a row for this device, but we hold no local
        // secret for it — a lost response, or state wiped after a prior
        // successful provision. Self-heal once: revoke the now-orphaned row
        // (its raw secret is gone for good) and mint a genuinely fresh one,
        // rather than retrying the exact call that can never succeed as-is.
        await api.revokeAgentToken(minted.id).catch(() => {});
        if (cancelled) return;
        const retry = await api
          .createAgentToken("desktop", deviceLabel(), state.deviceKey)
          .catch(() => null);
        if (!cancelled && retry?.token) await agent.pair(retry.token);
        return;
      }

      await agent.pair(minted.token);
      // Never agent.setEnabled(true) here — pairing readiness is not consent.
      toast("Activity tracking is ready to turn on for this device", {
        description: "Visit Settings → Your activity to turn it on.",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [config, api, status]);

  return null;
}

/**
 * The other half of the sign-in-page "Install Browser Extension" flow (see
 * features/BrowserExtensionCTA.tsx's own docstring for why the CTA itself
 * cannot finish this pre-login): once someone signs in, silently check
 * whether the extension is now reachable and pair it if so.
 *
 * `useExtensionConnection` already IS this whole mechanism — ping, and if
 * installed-but-unpaired, mint + provision (see its own doc comment). This
 * component only adds the "tell the person it just happened" toast, and only
 * for a FRESH pairing — not for one that was already connected, which needs
 * no announcement.
 *
 * A no-op everywhere the hook itself already no-ops: no `chromeExtensionId`
 * configured for this deployment, no `chrome.runtime` (Electron — the
 * desktop app has its own agent, see AgentProvisioningBridge above), or the
 * extension genuinely isn't installed.
 *
 * Mounted at the app root (present on every route, including pre-login ones),
 * so it does not even PING until `status === "authed"` — mirrors
 * AgentProvisioningBridge's own gate above. Pinging pre-login is
 * BrowserExtensionCTA's job (the sign-in page), not this bridge's; doing it
 * here too would just be a second, redundant ping racing the same one.
 */
export function ExtensionProvisioningBridge() {
  const status = useSession((s) => s.status);
  if (status !== "authed") return null;
  return <ExtensionAutoConnect />;
}

function ExtensionAutoConnect() {
  const { status: extensionStatus } = useExtensionConnection(true);
  const announced = useRef(false);

  useEffect(() => {
    if (extensionStatus === "provisioned" && !announced.current) {
      announced.current = true;
      toast("Browser extension connected", { description: "It will start reporting activity shortly." });
    }
  }, [extensionStatus]);

  return null;
}
