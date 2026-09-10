/**
 * Download wiring for the "Get the App" flow.
 *
 * Installers are built by the BlissWork desktop app (apps/desktop,
 * electron-builder) with STABLE, version-less artifact names (e.g.
 * BlissWork-windows-x64.exe) and hosted on OUR OWN VPS — NOT GitHub. They are
 * served straight from this site at `/downloads/<name>` (Caddy `file_server`
 * over the mounted dist/, and mirrored on communication.rnrtechs.com via nginx),
 * so a click downloads directly from our server with no redirect to GitHub.
 *
 * The filenames are stable and version-less on purpose: the desktop release
 * overwrites them in place, so this file never needs updating when the desktop
 * app ships a new version.
 *
 * Publishing today is `docker compose -f docker-compose.prod.yml --profile
 * desktop up desktop-builder` on the VPS (Linux + Windows/Wine), which writes
 * straight into the served directory. macOS still has to be built on a Mac and
 * published with Bliss-Work/scripts/publish-desktop.sh. This comment used to
 * claim release.yml republished these on every green build of `main` — it does
 * not: `main` does not exist on the remote, so that workflow has never fired.
 *
 * To repoint downloads to another host (S3 / CDN / a different server), edit
 * RELEASE_BASE or the per-asset `url` fields below.
 *
 * ⚠️ KEEP IN SYNC with Bliss-Work/packages/app/src/lib/downloads.ts — the web app
 * has a near-identical copy of this config (separate repos, so it can't be
 * shared). Any filename or path change must be made in both, or one of the two
 * "Get the App" buttons starts 404ing.
 */

const RELEASE_BASE = "/downloads";

export type PlatformId = "windows" | "mac" | "linux";

export interface DownloadAsset {
  /** Sub-label, e.g. "Apple Silicon" or "Installer". */
  label: string;
  /** File extension shown to the user, e.g. ".dmg". */
  ext: string;
  /** Direct download URL. */
  url: string;
}

export interface Platform {
  id: PlatformId;
  name: string;
  /** e.g. "Windows 10 & 11 · 64-bit". */
  requirement: string;
  /** Primary CTA asset (the one used by one-click "Download for X"). */
  primary: DownloadAsset;
  /** All available assets (arch / format variants). */
  assets: DownloadAsset[];
}

export const PLATFORMS: Record<PlatformId, Platform> = {
  windows: {
    id: "windows",
    name: "Windows",
    requirement: "Windows 10 & 11 · 64-bit",
    primary: {
      label: "Installer (.exe)",
      ext: ".exe",
      url: `${RELEASE_BASE}/BlissWork-windows-x64.exe`,
    },
    assets: [
      { label: "Installer (.exe)", ext: ".exe", url: `${RELEASE_BASE}/BlissWork-windows-x64.exe` },
    ],
  },
  mac: {
    id: "mac",
    name: "macOS",
    requirement: "macOS 11 Big Sur or later",
    primary: {
      label: "Apple Silicon (.dmg)",
      ext: ".dmg",
      url: `${RELEASE_BASE}/BlissWork-mac-arm64.dmg`,
    },
    assets: [
      { label: "Apple Silicon (.dmg)", ext: ".dmg", url: `${RELEASE_BASE}/BlissWork-mac-arm64.dmg` },
      { label: "Intel (.dmg)", ext: ".dmg", url: `${RELEASE_BASE}/BlissWork-mac-x64.dmg` },
    ],
  },
  linux: {
    id: "linux",
    name: "Linux",
    requirement: "AppImage (universal) or .deb",
    primary: {
      label: "AppImage",
      ext: ".AppImage",
      url: `${RELEASE_BASE}/BlissWork-linux-x64.AppImage`,
    },
    assets: [
      { label: "AppImage", ext: ".AppImage", url: `${RELEASE_BASE}/BlissWork-linux-x64.AppImage` },
      { label: "Debian / Ubuntu (.deb)", ext: ".deb", url: `${RELEASE_BASE}/BlissWork-linux-x64.deb` },
    ],
  },
};

export const PLATFORM_ORDER: PlatformId[] = ["windows", "mac", "linux"];

function platformUA(): string {
  if (typeof navigator === "undefined") return "";
  return (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.userAgent ||
    navigator.platform ||
    ""
  ).toLowerCase();
}

/** True on iOS/Android — there is no mobile app, so callers must not treat
 *  this like a resolved desktop platform (there's no installer that would
 *  run on it). Checked separately from, and before, detectPlatform's own
 *  "mac"/"linux" substring matches, which iphone/ipad/android UAs also
 *  contain. */
export function isMobileVisitor(): boolean {
  const ua = platformUA();
  return ua.includes("iphone") || ua.includes("ipad") || ua.includes("android");
}

/** Best-effort detection of the visitor's OS to pre-highlight a platform.
 *  Returns null on mobile (see isMobileVisitor) as well as when detection is
 *  inconclusive — both cases fall back to the platform-picker modal rather
 *  than starting a download the visitor's device can't use. */
export function detectPlatform(): PlatformId | null {
  if (isMobileVisitor()) return null;
  const ua = platformUA();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return null;
}

/**
 * Optional "all downloads / older versions" link, rendered by DownloadProvider
 * only when non-empty. Empty because there is no such page: installers are
 * published under stable, version-less names on our own host and only the
 * current release is kept.
 */
export const ALL_RELEASES_URL = "";
