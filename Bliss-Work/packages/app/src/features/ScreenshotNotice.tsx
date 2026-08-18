import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { surfaceOf } from "../lib/section";
import { getSessionId } from "../lib/telemetrySession";
import { SCREENSHOT_BLOCKED_MESSAGE, watchCaptureKeys } from "../lib/screenGuard";

/**
 * Warns the user on a detected screenshot attempt, and reports it to the server.
 *
 * Renders nothing. Mounted once, next to the <Toaster />, because an attempt can
 * happen on any screen and the warning has to appear wherever the user is.
 *
 * TWO DETECTORS, one message:
 *
 *   • Desktop — the Electron main process. It excludes the window from OS
 *     capture where the platform allows (Windows, macOS) and sees capture chords
 *     a page never receives. It tells us through `onScreenshotBlocked`.
 *   • Web — this page, via `watchCaptureKeys`. A browser cannot exclude itself
 *     from capture and cannot see the chords the shell swallows, so this is
 *     detection and warning only. It is installed ONLY when the desktop host is
 *     absent; running both would double-report the same keystroke.
 *
 * The attempt is reported to telemetry-svc so the control leaves a record on the
 * SERVER rather than a toast that vanishes with the tab — an admin can see it in
 * the member's activity timeline. Reporting is skipped when the desktop has
 * already recorded it through the activity agent (`recorded`), and when there is
 * no session to attribute it to. The warning itself always fires: a signed-out
 * user still gets told, we simply have nobody to record it against.
 */
export function ScreenshotNotice() {
  const { api, config } = useRuntime();
  const authed = useSession((s) => s.status) === "authed";

  const onAttempt = useCallback(
    (chord: string, alreadyRecorded: boolean) => {
      toast.error(SCREENSHOT_BLOCKED_MESSAGE);
      if (alreadyRecorded || !authed) return;

      // Flushed on its own rather than queued with the ordinary beacon traffic:
      // a security event that arrives half an hour later, if the tab survives
      // that long, is worth much less than one that arrives now. Failure is
      // swallowed for the reason all telemetry is — it must never break, or
      // interrupt, the thing it observes.
      void api
        .sendBeacon({
          sessionId: getSessionId(),
          source: config.kind === "web" ? "web" : "desktop",
          activeMs: 0,
          idleMs: 0,
          ended: false,
          events: [
            {
              action: "screenshot.attempted",
              category: "security",
              occurredAt: new Date().toISOString(),
              surface: surfaceOf(window.location.pathname) ?? undefined,
              detail: { chord },
            },
          ],
        })
        .catch(() => {});
    },
    [api, authed, config.kind],
  );

  useEffect(() => {
    // Debouncing for the desktop path lives in main (screenshot-guard.ts
    // coalesces bursts), not here — the renderer can be reloaded mid-burst and
    // would lose its own counter. The web watcher keeps its own for the same
    // reason main keeps one: nothing else is watching.
    if (config.onScreenshotBlocked) {
      return config.onScreenshotBlocked((info) =>
        onAttempt(info?.chord ?? "desktop", info?.recorded ?? false),
      );
    }
    return watchCaptureKeys((chord) => onAttempt(chord, false));
  }, [config, onAttempt]);

  return null;
}
