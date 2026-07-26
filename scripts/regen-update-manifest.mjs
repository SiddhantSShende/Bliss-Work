#!/usr/bin/env node
/**
 * Rewrite an electron-updater `latest*.yml` manifest against the artifacts as
 * they exist on disk RIGHT NOW.
 *
 * Why this exists
 * ---------------
 * `.github/workflows/release.yml` packages on the native runners and then signs
 * the Windows installer in a *later* job (SSL.com eSigner is cross-platform, so
 * signing happens on Linux). Signing rewrites the `.exe`, which invalidates the
 * `sha512` electron-builder recorded while the binary was still unsigned.
 *
 * electron-updater verifies that hash after downloading and refuses to install
 * on a mismatch — so without this step every signed release would download
 * fine and then fail at the last moment, for every user, silently enough that
 * you would only find out from support tickets.
 *
 * Run it after signing and before publishing.
 *
 *   node scripts/regen-update-manifest.mjs <dir> <manifest> <artifact...>
 *   node scripts/regen-update-manifest.mjs installers latest.yml BlissWork-windows-x64.exe
 *
 * The manifest schema is a handful of fixed keys, so this regenerates the file
 * rather than patching it — which keeps the script dependency-free (no YAML
 * parser) and makes the output impossible to half-update.
 *
 * `version` is carried over from the existing manifest: it is the value the
 * installer was actually built with, and inventing a different one here would
 * ship a manifest that disagrees with the binary.
 *
 * Only the Windows manifest needs this. macOS is signed in-place during
 * packaging (electron-builder hashes afterwards) and Linux is never re-signed,
 * so `latest-mac.yml` / `latest-linux.yml` pass through untouched.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

const [dir, manifestName, ...artifacts] = process.argv.slice(2);

if (!dir || !manifestName || artifacts.length === 0) {
  console.error("usage: regen-update-manifest.mjs <dir> <manifest.yml> <artifact...>");
  process.exit(2);
}

const manifestPath = join(dir, manifestName);
if (!existsSync(manifestPath)) {
  console.error(
    `✗ ${manifestPath} not found.\n` +
      "  electron-builder writes latest*.yml next to the installers whenever a\n" +
      "  `publish` provider is configured. If it is missing, the publish block in\n" +
      "  apps/desktop/package.json was dropped — auto-update is broken without it.",
  );
  process.exit(1);
}

// Pull `version` out of the existing manifest without a YAML dependency. The
// line electron-builder emits is exactly `version: 1.2.3`.
const previous = readFileSync(manifestPath, "utf8");
const versionMatch = previous.match(/^version:\s*'?"?([^'"\s]+)'?"?\s*$/m);
if (!versionMatch) {
  console.error(`✗ no \`version:\` line in ${manifestPath}; refusing to guess.`);
  process.exit(1);
}
const version = versionMatch[1];

/** electron-updater compares base64-encoded sha512 digests, not hex. */
function sha512Base64(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

const files = artifacts.map((name) => {
  const path = join(dir, name);
  if (!existsSync(path)) {
    console.error(`✗ artifact not found: ${path}`);
    process.exit(1);
  }
  return { url: basename(name), sha512: sha512Base64(path), size: statSync(path).size };
});

// A blockmap describes the byte layout of the UNSIGNED binary. After signing it
// no longer matches, and a stale blockmap makes the differential downloader do
// pointless work before falling back. Delete it: a full download is correct and
// the manifest above no longer references it.
for (const { url } of files) {
  const blockmap = join(dir, `${url}.blockmap`);
  if (existsSync(blockmap)) {
    rmSync(blockmap);
    console.log(`  removed stale ${url}.blockmap (invalidated by signing)`);
  }
}

// `path`/`sha512` at the top level are the legacy single-artifact fields that
// older electron-updater clients read; they mirror files[0].
const yaml =
  `version: ${version}\n` +
  `files:\n` +
  files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}\n`).join("") +
  `path: ${files[0].url}\n` +
  `sha512: ${files[0].sha512}\n` +
  `releaseDate: '${new Date().toISOString()}'\n`;

writeFileSync(manifestPath, yaml);

console.log(`✓ regenerated ${manifestPath} for version ${version}`);
for (const f of files) console.log(`  ${f.url}  ${f.size} bytes  sha512=${f.sha512.slice(0, 16)}…`);
