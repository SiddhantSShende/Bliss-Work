#!/usr/bin/env node
/**
 * Stamp a version into the desktop app, at build time only.
 *
 *   node scripts/set-desktop-version.mjs 0.1.42
 *
 * electron-builder reads `version` from apps/desktop/package.json and writes it
 * into both the installer and the `latest*.yml` update manifest. electron-updater
 * then compares that against the running app's version — so this number is the
 * ONLY thing that decides whether an installed app sees an update.
 *
 * `.github/workflows/release.yml` calls this with `0.1.<github.run_number>` on
 * every green main build. run_number is monotonic, so successive releases always
 * compare greater.
 *
 * Deliberately NOT committed back to the repo: a version-bump commit would
 * retrigger CI, which would retrigger the release workflow, which would bump
 * again — forever. The repo keeps a static 0.1.0 and CI stamps the real number.
 * That means a locally-packaged build is always 0.1.0 and will always think an
 * update is available, which is correct: your local build is not a release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const version = process.argv[2];

// Match npm's own semver shape. A malformed version here would produce a
// manifest electron-updater silently declines to compare.
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: set-desktop-version.mjs <semver>   (got: ${version ?? "nothing"})`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function patchJson(path, mutate) {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  if (!mutate(json)) return false;
  // Match npm's formatting: two-space indent, trailing newline.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

const pkgPath = join(root, "apps/desktop/package.json");
patchJson(pkgPath, (pkg) => {
  pkg.version = version;
  return true;
});

// Keep the lockfile consistent with the manifest. Without this a later `npm ci`
// in the same job fails with EUSAGE ("lock file does not satisfy package.json"),
// which is a confusing way to discover a version stamp.
const lockPath = join(root, "package-lock.json");
patchJson(lockPath, (lock) => {
  const entry = lock.packages?.["apps/desktop"];
  if (!entry) return false;
  entry.version = version;
  return true;
});

console.log(`✓ desktop version set to ${version}`);
