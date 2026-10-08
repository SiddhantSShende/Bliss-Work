/**
 * Which entry of a `latest*.yml` `files[]` list electron-updater actually
 * downloads on this machine.
 *
 * `latest-mac.yml` lists a zip AND a dmg for each of x64 and arm64, so the
 * first entry is routinely not the installer that is fetched. The second-source
 * integrity check (updater.ts → update-integrity.ts) has to compare the hash of
 * the file that really gets installed, so it needs the same pick. Returns null
 * when the list has no unambiguous match; the caller must then refuse the
 * update rather than check some other file's hash.
 *
 * Mirrors electron-updater's own choice: Windows installs the NSIS `.exe`,
 * macOS the `.zip` (never the `.dmg`), Linux the `.AppImage`. Naming follows
 * this app's electron-builder `artifactName` (`BlissWork-<os>-<arch>.<ext>`).
 */

const EXTENSION: Partial<Record<NodeJS.Platform, string>> = {
  win32: ".exe",
  darwin: ".zip",
  linux: ".appimage",
};

/** The architecture a file name declares, or null when it declares none. */
function archOf(url: string): string | null {
  const name = url.toLowerCase();
  if (/arm64|aarch64/.test(name)) return "arm64";
  if (/x64|x86[_-]64|amd64/.test(name)) return "x64";
  if (/ia32|i386|x86/.test(name)) return "ia32";
  return null;
}

export function pickDownloadedFile<T extends { url: string }>(
  files: readonly T[],
  platform: NodeJS.Platform,
  arch: string,
): T | null {
  const extension = EXTENSION[platform];
  if (!extension) return null;
  const candidates = files.filter((f) => f.url.toLowerCase().split(/[?#]/)[0]!.endsWith(extension));
  const forThisArch = candidates.filter((f) => archOf(f.url) === arch);
  if (forThisArch.length > 0) return forThisArch.length === 1 ? forThisArch[0]! : null;
  // No file names an architecture at all: a single universal installer.
  const universal = candidates.filter((f) => archOf(f.url) === null);
  return universal.length === 1 ? universal[0]! : null;
}
