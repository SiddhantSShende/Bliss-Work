import { useEffect } from "react";
import { toast } from "sonner";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { deviceLabel } from "../features/DeviceActivitySettings";

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
