import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Read-only "is this browser installed" detection, per OS.
 *
 * No registry writes, no policy files, no filesystem changes of any kind —
 * every check here only ever READS whether a known install location exists.
 * This is deliberately narrower than a real installed-software inventory:
 * it recognises the browsers this app can plausibly help provision the
 * extension for (see extensionInstallUrls in packages/app), checked at their
 * common install paths. A browser installed somewhere nonstandard (a custom
 * MSI target dir, a portable build) is reported absent, not "unsupported" —
 * see DetectedBrowser's own doc comment on why that distinction matters.
 */
export type BrowserFamily = "chrome" | "edge" | "brave" | "firefox" | "safari";

export interface DetectedBrowser {
  family: BrowserFamily;
  label: string;
  /** Absolute path to the executable, for `launchBrowser` below. Present iff
   *  `installed` is true. */
  path: string | null;
  installed: boolean;
}

const LABELS: Record<BrowserFamily, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  firefox: "Firefox",
  safari: "Safari",
};

interface Candidate {
  family: BrowserFamily;
  /** Absolute paths to try, in order — first hit wins. */
  paths: string[];
}

function windowsCandidates(): Candidate[] {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env["LocalAppData"] || join(homedir(), "AppData", "Local");
  return [
    {
      family: "chrome",
      paths: [
        join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ],
    },
    {
      family: "edge",
      // Edge ships in-box on Windows 10/11 — the Program Files path is the
      // one that matters, x86 because Edge is still distributed as a 32-bit
      // installer on some builds even on a 64-bit OS.
      paths: [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe")],
    },
    {
      family: "brave",
      paths: [
        join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
    },
    {
      family: "firefox",
      paths: [join(pf, "Mozilla Firefox", "firefox.exe"), join(pf86, "Mozilla Firefox", "firefox.exe")],
    },
  ];
}

function macCandidates(): Candidate[] {
  const bundle = (name: string) => `/Applications/${name}.app`;
  return [
    { family: "chrome", paths: [bundle("Google Chrome")] },
    { family: "edge", paths: [bundle("Microsoft Edge")] },
    { family: "brave", paths: [bundle("Brave Browser")] },
    { family: "firefox", paths: [bundle("Firefox")] },
    // Safari ships with every macOS install — no separate check needed.
    { family: "safari", paths: ["/Applications/Safari.app"] },
  ];
}

/** Linux has no fixed install path convention — `which` is the closest thing
 *  to a standard "is this on PATH" check across distros/package managers. */
const LINUX_BINARY_NAMES: Record<Exclude<BrowserFamily, "safari">, string[]> = {
  chrome: ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"],
  edge: ["microsoft-edge-stable", "microsoft-edge"],
  brave: ["brave-browser", "brave"],
  firefox: ["firefox"],
};

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    const path = stdout.trim();
    return path || null;
  } catch {
    return null;
  }
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Detect which supported browsers are installed on this machine. Read-only. */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const platform = process.platform;

  if (platform === "win32") {
    return windowsCandidates().map(({ family, paths }) => {
      const path = firstExisting(paths);
      return { family, label: LABELS[family], path, installed: path !== null };
    });
  }

  if (platform === "darwin") {
    return macCandidates().map(({ family, paths }) => {
      const path = firstExisting(paths);
      return { family, label: LABELS[family], path, installed: path !== null };
    });
  }

  if (platform === "linux") {
    const families = Object.keys(LINUX_BINARY_NAMES) as Array<keyof typeof LINUX_BINARY_NAMES>;
    const results = await Promise.all(
      families.map(async (family) => {
        for (const bin of LINUX_BINARY_NAMES[family]) {
          const path = await which(bin);
          if (path) return { family, label: LABELS[family], path, installed: true };
        }
        return { family, label: LABELS[family], path: null, installed: false };
      }),
    );
    // No Safari on Linux at all — not "not installed", genuinely not a thing
    // this platform has, so it is left out rather than reported as absent.
    return results;
  }

  // An OS this app doesn't otherwise support running on; nothing to report.
  return [];
}

/**
 * Launch a detected browser at a URL — this is what makes "detect the
 * extension" possible at all from Electron: there is no `chrome.runtime` in
 * a renderer (see extensionProvisioning.ts's own doc comment), so the only
 * way to run the real detection/provisioning handshake is inside an actual
 * browser tab, which only exists once one is opened there.
 *
 * Safe by construction, not by validation: `path` must be one this module's
 * OWN `detectBrowsers()` just found on disk (never a renderer-supplied
 * string), and `execFile` (not `exec`) never invokes a shell — the URL is
 * passed as a literal argv entry, so it cannot be interpreted as a second
 * command no matter what it contains. This is the same class of operation as
 * any OS "Open with…" menu, not a workaround of one.
 */
export async function launchBrowser(path: string, url: string): Promise<void> {
  await execFileAsync(path, [url]);
}
