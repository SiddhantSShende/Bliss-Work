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
    titleTracking: boolean;
    titleTrackingReason: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    setState(await agent.state());
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-checks while this screen is open, so a permission REVOKED in System
  // Settings — the scenario macos-permissions.ts's own docstring flags as
  // sometimes lagging behind in the OS's cached status — becomes visible
  // here without the person having to leave and re-open Settings. Not a
  // background poll: it only runs while this component is mounted, matching
  // every other "is this still true" check in this screen.
  useEffect(() => {
    if (!agent) return;
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [agent, load]);

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
      // On macOS, pairing is the moment the FIRST foreground read happens,
      // which is also the moment macOS shows its own native Screen Recording
      // prompt — outside this app's control, and easy to mistake for
      // something going wrong if nobody said it was coming (see
      // main/macos-permissions.ts: the OS fires this prompt automatically on
      // the first gated call, with no API to trigger or suppress it).
      toast.success(
        isMacOS()
          ? "This device is now recording your activity. macOS may ask for Screen Recording access — allow it to include window titles."
          : "This device is now recording your activity",
      );
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
          <li>Application <strong>names</strong> and, where the operating system exposes it, the window <strong>title</strong> — never a window's contents.</li>
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

        {/* Narrower than the block above: application-name tracking already
            works (macOS exposes "which process is frontmost" unconditionally
            — see main/macos-permissions.ts's docstring on what Screen
            Recording does and does not gate); only the window-title line is
            missing. Shown ONLY once paired, so this never appears as a
            reason not to turn the feature on in the first place — someone
            deciding whether to enable activity tracking at all should not be
            handed a permissions checklist before they have even said yes. */}
        {state?.paired && state.appTracking && !state.titleTracking && (
          <div className="flex items-start gap-1.5 rounded-lg bg-surface-2 p-2 text-xs text-muted">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                Application names are recorded, but window titles are not yet
                ({state.titleTrackingReason}). macOS calls this Screen Recording
                access.
              </p>
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => void agent?.openScreenRecordingSettings()}
              >
                Open Screen Recording settings
              </button>
            </div>
          </div>
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
 *  the platform, not a fingerprint. Exported for reuse by agentProvisioning.tsx,
 *  which mints the same kind of token automatically at login. */
export function deviceLabel(): string {
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

/**
 * Whether this render is happening on a macOS build.
 *
 * Used ONLY to decide whether to mention the Screen Recording prompt before
 * it happens — never to change what gets recorded or requested, which stays
 * identical across platforms and is decided in the main process regardless
 * of anything the renderer believes about its own OS.
 */
function isMacOS(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
}
