import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Chrome } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";

/**
 * Desktop's half of browser-extension provisioning: which supported browsers
 * are installed on THIS machine, and a way to open BlissWork inside one of
 * them so its real detection/connection flow (BrowserExtensionCTA /
 * ConnectedAgents, both in this same package) can take over.
 *
 * Deliberately does NOT claim to know whether the extension is installed or
 * connected in each browser — it genuinely can't: there is no `chrome.runtime`
 * in an Electron renderer, so that question can only be answered from inside
 * an actual browser tab (see apps/desktop/src/main/browser-detect.ts's own
 * doc comment). Showing "detected" rather than "connected"/"not connected"
 * here is what keeps this honest rather than a state this app cannot back up.
 *
 * Renders only in the desktop app — `config.browserAgent` is absent on web,
 * where the browser IS the page already.
 */
export function BrowserExtensionProvisioning() {
  const { config } = useRuntime();
  const agent = config.browserAgent;
  const [browsers, setBrowsers] = useState<
    Array<{ family: string; label: string; path: string | null; installed: boolean }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    void (async () => {
      const list = await agent.list();
      if (!cancelled) {
        setBrowsers(list);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent]);

  if (!agent) return null;

  const installed = browsers.filter((b) => b.installed);

  const openIn = async (b: (typeof browsers)[number]) => {
    if (!b.path) return;
    setLaunching(b.path);
    try {
      const ok = await agent.launch(b.path);
      if (!ok) toast.error(`Couldn't open ${b.label}`);
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/60 p-4">
      <Chrome size={18} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-semibold text-fg">Browser extension</h3>
        <p className="text-sm leading-relaxed text-muted">
          Add the sites you use to your activity record by connecting the BlissWork extension in a
          browser on this device.
        </p>

        {loading ? (
          <p className="text-xs text-muted">Checking installed browsers…</p>
        ) : installed.length === 0 ? (
          <p className="text-xs text-muted">No supported browser was found on this device.</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {installed.map((b) => (
              <li key={b.family} className="flex items-center justify-between gap-3 rounded-lg p-1.5">
                <span className="text-sm text-fg">{b.label}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={launching === b.path}
                  onClick={() => void openIn(b)}
                >
                  Connect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
