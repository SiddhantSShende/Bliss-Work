/**
 * "Get the App" download wiring for the WEB app (communication.rnrtechs.com).
 *
 * The desktop installers are produced by the BlissWork desktop build
 * (apps/desktop, electron-builder) with STABLE, version-less names
 * (BlissWork-windows-x64.exe, …) and hosted on our own VPS — NOT GitHub. They
 * are served through our server at `/downloads/<name>` (nginx location, see
 * infra/nginx/default.conf), so a click downloads straight from
 * communication.rnrtechs.com with no redirect to GitHub.
 *
 * The names are version-less on purpose: the release overwrites them in place,
 * so this file never changes when the desktop app ships. That is also why
 * /downloads is served `Cache-Control: no-cache` (infra/nginx/default.conf) —
 * the URL is stable while the bytes behind it change, so the browser must
 * revalidate or it will hand back a previous release's installer.
 *
 * Publishing is `docker compose --profile desktop up desktop-builder`, which
 * builds Linux + Windows here and writes straight into the served directory.
 * (It used to be .github/workflows/release.yml; that rsynced from a hosted
 * runner and is retired.) macOS still has to be built on a Mac and published
 * with scripts/publish-desktop.sh.
 *
 * To repoint downloads elsewhere (e.g. the marketing site's host or a CDN) set
 * VITE_DOWNLOADS_BASE at build time — nothing else needs to change.
 *
 * ⚠️ KEEP IN SYNC with Bliss-Website/src/config/downloads.ts — the marketing site
 * has a near-identical copy of this config (separate repos, so it can't be
 * shared). Any filename or path change must be made in both, or one of the two
 * "Get the App" buttons starts 404ing.
 */

// `import.meta.env` is Vite's build-time env (statically replaced). packages/app
// is consumed by both the web + electron Vite builds; cast to `any` so this
// compiles without pulling vite/client types into this shared package's tsconfig.
const VITE_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const RELEASE_BASE = (VITE_ENV.VITE_DOWNLOADS_BASE ?? "/downloads").replace(/\/$/, "");

export type PlatformId = "windows" | "mac" | "linux";

export interface DownloadAsset {
  /** Sub-label, e.g. "Apple Silicon" or "Installer (.exe)". */
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
  /** Primary CTA asset (used by the one-click "Download for X"). */
  primary: DownloadAsset;
  /** All available assets (arch / format variants). */
  assets: DownloadAsset[];
}

export const PLATFORMS: Record<PlatformId, Platform> = {
  windows: {
    id: "windows",
    name: "Windows",
    requirement: "Windows 10 & 11 · 64-bit",
    primary: { label: "Installer (.exe)", ext: ".exe", url: `${RELEASE_BASE}/BlissWork-windows-x64.exe` },
    assets: [
      { label: "Installer (.exe)", ext: ".exe", url: `${RELEASE_BASE}/BlissWork-windows-x64.exe` },
    ],
  },
  mac: {
    id: "mac",
    name: "macOS",
    requirement: "macOS 11 Big Sur or later",
    primary: { label: "Apple Silicon (.dmg)", ext: ".dmg", url: `${RELEASE_BASE}/BlissWork-mac-arm64.dmg` },
    assets: [
      { label: "Apple Silicon (.dmg)", ext: ".dmg", url: `${RELEASE_BASE}/BlissWork-mac-arm64.dmg` },
      { label: "Intel (.dmg)", ext: ".dmg", url: `${RELEASE_BASE}/BlissWork-mac-x64.dmg` },
    ],
  },
  linux: {
    id: "linux",
    name: "Linux",
    requirement: "AppImage (universal) or .deb",
    primary: { label: "AppImage", ext: ".AppImage", url: `${RELEASE_BASE}/BlissWork-linux-x64.AppImage` },
    assets: [
      { label: "AppImage", ext: ".AppImage", url: `${RELEASE_BASE}/BlissWork-linux-x64.AppImage` },
      { label: "Debian / Ubuntu (.deb)", ext: ".deb", url: `${RELEASE_BASE}/BlissWork-linux-x64.deb` },
    ],
  },
};

export const PLATFORM_ORDER: PlatformId[] = ["windows", "mac", "linux"];

/** Best-effort detection of the visitor's OS to pre-highlight a platform. */
export function detectPlatform(): PlatformId | null {
  if (typeof navigator === "undefined") return null;
  const ua = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.userAgent ||
    navigator.platform ||
    ""
  ).toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac") || ua.includes("iphone") || ua.includes("ipad")) return "mac";
  if (ua.includes("linux") || ua.includes("android") || ua.includes("x11")) return "linux";
  return null;
}
