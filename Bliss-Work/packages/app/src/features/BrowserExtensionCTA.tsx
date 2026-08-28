import type { ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { detectBrowserFamily, supportsAutoExtensionIntegration } from "../lib/browserDetect";
import { useExtensionConnection } from "../lib/useExtensionConnection";

/**
 * "Browser Activity Tracking" — the sign-in page's honest answer to "is the
 * BlissWork extension connected here", and the only place a first-time
 * browser-only visitor is offered a way to install it.
 *
 * Deliberately never mints or provisions anything itself: minting a token
 * calls a session-authenticated endpoint (see useExtensionConnection.ts), and
 * there is no session yet on this page. It only ever PINGS (no auth needed —
 * `chrome.runtime.sendMessage` never leaves the browser) and, if the person
 * installs the extension and then signs in, the post-login provisioning
 * bridge (agentProvisioning.tsx) finishes the connection automatically —
 * this component just needs to get out of the way and let that happen, which
 * a plain re-render after navigating to /app already does.
 *
 * Renders nothing on the desktop app's own login screen: Electron has no
 * `chrome.runtime` (see extensionProvisioning.ts), so there is nothing here
 * for it to detect, and a permanently-inert "not supported" box would be
 * noise on every launch.
 */
export function BrowserExtensionCTA() {
  const { config } = useRuntime();
  const family = detectBrowserFamily();
  const canDetect = supportsAutoExtensionIntegration(family);
  // autoProvision: false — see the file doc comment above.
  const { status, recheck } = useExtensionConnection(false);

  if (config.kind !== "web") return null;

  const installUrl = config.extensionInstallUrls?.[family];

  let body: ReactNode;
  if (canDetect && (status === "connected" || status === "provisioned")) {
    body = (
      <p className="flex items-center gap-1.5 text-sm font-medium text-accent">
        <Check size={14} aria-hidden /> Extension Connected
      </p>
    );
  } else if (canDetect && status === "installed") {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-warning">
          <TriangleAlert size={14} aria-hidden /> Extension Not Connected
        </p>
        <Button size="sm" variant="ghost" onClick={() => void recheck()}>
          Reconnect
        </Button>
      </div>
    );
  } else if (installUrl) {
    body = (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => window.open(installUrl, "_blank", "noopener,noreferrer")}
      >
        Install Browser Extension
      </Button>
    );
  } else {
    body = <p className="text-xs text-muted">Browser not supported for automatic extension integration.</p>;
  }

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="mb-1.5 text-xs font-medium text-muted">Browser Activity Tracking</div>
      {body}
    </div>
  );
}
