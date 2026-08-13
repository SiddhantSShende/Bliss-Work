import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, MonitorCog } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";

/**
 * Consent for OS-level activity tracking on THIS machine.
 *
 * Renders only in the desktop app — `config.activityAgent` is absent on web,
 * where a browser cannot observe other applications at all.
 *
 * Three deliberate properties:
 *
 *   * It is OFF until the person turns it on. In-app analytics are covered by
 *     the workspace-wide notice; watching which applications someone opens is a
 *     categorically different thing and is not covered by having accepted terms
 *     of service.
 *   * The person pairing the device is the person being recorded. The pairing
 *     secret is minted from their own session, for themselves — an admin cannot
 *     mint one on someone's behalf, which would let an admin write activity
 *     attributed to a colleague.
 *   * It says plainly what is and is not collected, including the "not".
 */
export function DeviceActivitySettings() {
  const { api, config } = useRuntime();
  const agent = config.activityAgent;
  const [state, setState] = useState<{
    enabled: boolean;
    paired: boolean;
    appTracking: boolean;
    reason: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    setState(await agent.state());
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!agent) return null;

  /**
   * Pair and enable in one action.
   *
   * Splitting them would leave a state where the device is paired but not
   * sampling, which reads to the person as "I connected it, is it on or not?".
   * The token is minted here and handed straight to the main process — it never
   * touches component state, and the renderer never gets it back.
   */
  const connect = async () => {
    setBusy(true);
    try {
      const minted = await api.createAgentToken("desktop", deviceLabel());
      await agent.pair(minted.token);
      await agent.setEnabled(true);
      await load();
      toast.success("This device is now recording your activity");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not connect this device");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      // Unpairing locally stops the sampler immediately. The server-side token
      // is left for the person to revoke from their own token list — a device
      // that has been wiped or lost cannot unpair itself, so revocation has to
      // be possible from somewhere other than the device.
      await agent.pair(null);
      await load();
      toast.success("Stopped recording on this device");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await agent.setEnabled(!state?.enabled);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/60 p-4">
      <MonitorCog size={18} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-semibold text-fg">Activity on this device</h3>

        <p className="text-sm leading-relaxed text-muted">
          {state?.paired && state.enabled
            ? "This device is recording when you're at the keyboard, and which applications you have in front."
            : "Record when you're at the keyboard, and which applications you have in front, and add it to your activity record."}
        </p>

        <ul className="list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-muted">
          <li>Application <strong>names</strong> only — never window titles or their contents.</li>
          <li>Idle time and screen lock, from the operating system.</li>
          <li>Visible to you under Settings → Your activity, and to your workspace admins.</li>
        </ul>

        {state && !state.appTracking && (
          <p className="flex items-start gap-1.5 rounded-lg bg-surface-2 p-2 text-xs text-muted">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            {/* Said out loud rather than silently recording nothing: an empty
                "Apps used" panel would otherwise read to an admin as "they did
                no work", which is a materially different claim. */}
            Application tracking isn't available here ({state.reason}). Idle time and
            screen lock are still recorded.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {!state?.paired ? (
            <Button size="sm" loading={busy} onClick={connect}>
              Turn on for this device
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" loading={busy} onClick={toggle}>
                {state.enabled ? "Pause" : "Resume"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
                Turn off
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A label the person will recognise in their device list. Coarse on purpose —
 *  the platform, not a fingerprint. */
function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac/.test(ua)
      ? "macOS"
      : /Linux/.test(ua)
        ? "Linux"
        : "Desktop";
  return `${os} desktop`;
}
