import { useEffect } from "react";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";

/**
 * Tells the user when the desktop app refused a screenshot.
 *
 * Renders nothing. Mounted once, next to the <Toaster />, because the event
 * arrives from the Electron main process rather than from any one screen and
 * the warning has to appear wherever the user happens to be.
 *
 * Inert on the web build, where `onScreenshotBlocked` is absent: a page cannot
 * observe the OS's capture keys, so there is nothing to subscribe to.
 *
 * Debouncing lives in main (screenshot-guard.ts coalesces bursts), not here —
 * the renderer can be reloaded mid-burst and would lose its own counter.
 */
export function ScreenshotNotice() {
  const { config } = useRuntime();

  useEffect(() => {
    return config.onScreenshotBlocked?.(() => {
      toast.error("Screenshot attempt detected. Screenshots are not allowed.");
    });
  }, [config]);

  return null;
}
