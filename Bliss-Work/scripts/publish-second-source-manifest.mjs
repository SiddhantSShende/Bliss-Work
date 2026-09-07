#!/usr/bin/env node
/**
 * Publish the independent second-source integrity manifest that
 * apps/desktop/src/main/update-integrity.ts's `checkSecondSource` checks
 * every downloaded update against.
 *
 * Why this exists
 * ----------------
 * The desktop app's ONLY integrity check today is a sha512 fetched from
 * `latest.yml` on the same host as the installer itself — see update-
 * integrity.ts's header for the full threat model. This script publishes
 * the same hashes to a genuinely separate repo (github.com/AE-4pvt/
 * blisswork-update-manifest, served to the app via raw.githubusercontent.com)
 * so a compromised primary host/pipeline no longer means "the integrity
 * check verifies the attacker's file against the attacker's own hash."
 *
 * Run this AFTER publishing installers to the live download host (either
 * `scripts/publish-desktop.sh` or the `desktop-builder` compose profile) —
 * it reads whatever `latest*.yml` files are already there and does not
 * recompute any hash itself, on purpose: the point is to catch the primary
 * feed disagreeing with itself between publish and download, not to be a
 * third hash algorithm with its own bugs.
 *
 *   node scripts/publish-second-source-manifest.mjs <dir-with-latest-ymls> [--dry-run]
 *   node scripts/publish-second-source-manifest.mjs /home/ubuntu/BlissWork/downloads
 *
 * Env:
 *   MANIFEST_REPO_GIT_URL   defaults to the https URL below. Needs `git`
 *                           already able to authenticate against it — e.g.
 *                           `gh auth login` on this host, or a token baked
 *                           into the URL for a CI job.
 *   MANIFEST_REPO_DIR       an already-cloned checkout to reuse instead of
 *                           cloning fresh into a temp dir. Must be a clean
 *                           checkout of MANIFEST_REPO_GIT_URL on its default
 *                           branch — this script does not create one.
 *
 * Every platform's `latest*.yml` in <dir> is merged into ONE manifest.json
 * (checkSecondSource looks artifacts up by filename, not by platform), and
 * every file's `version:` must agree — a publish that only regenerated one
 * platform's manifest, or is caught mid-release across platforms, must not
 * silently mix versions.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_REPO_URL = "https://github.com/AE-4pvt/blisswork-update-manifest.git";

const [dir, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run");

if (!dir) {
  console.error("usage: publish-second-source-manifest.mjs <dir-with-latest-ymls> [--dry-run]");
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`✗ no such directory: ${dir}`);
  process.exit(1);
}

const ymlFiles = readdirSync(dir).filter((f) => /^latest.*\.yml$/.test(f));
if (ymlFiles.length === 0) {
  console.error(`✗ no latest*.yml found in ${dir} — publish installers there first.`);
  process.exit(1);
}

/** Extract `version: 1.2.3` and every `- url: X` / `sha512: Y` pair, without
 *  a YAML dependency — same reasoning as regen-update-manifest.mjs. */
function parseManifest(text, sourceFile) {
  const versionMatch = text.match(/^version:\s*'?"?([^'"\s]+)'?"?\s*$/m);
  if (!versionMatch) {
    console.error(`✗ no \`version:\` line in ${sourceFile}; refusing to guess.`);
    process.exit(1);
  }
  const files = {};
  const fileBlockRe = /- url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)/g;
  let m;
  while ((m = fileBlockRe.exec(text))) {
    files[m[1]] = m[2];
  }
  if (Object.keys(files).length === 0) {
    console.error(`✗ no \`- url:\` / \`sha512:\` entries found in ${sourceFile}; refusing to publish an empty manifest.`);
    process.exit(1);
  }
  return { version: versionMatch[1], files };
}

let version = null;
const files = {};
for (const name of ymlFiles) {
  const parsed = parseManifest(readFileSync(join(dir, name), "utf8"), name);
  if (version === null) {
    version = parsed.version;
  } else if (version !== parsed.version) {
    console.error(
      `✗ ${name} is version ${parsed.version}, but an earlier manifest in this directory was ${version} — ` +
        "refusing to publish a manifest that mixes versions across platforms.",
    );
    process.exit(1);
  }
  Object.assign(files, parsed.files);
}

const manifest = { version, files };
console.log(`Merged ${ymlFiles.length} manifest(s) for version ${version}:`);
for (const [name, sha512] of Object.entries(files)) {
  console.log(`  ${name}  sha512=${sha512.slice(0, 16)}…`);
}

if (dryRun) {
  console.log("\n--dry-run: not publishing. Would write:");
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

// ── Clone (or reuse) the mirror repo, write, commit, push ──────────────────
const repoUrl = process.env.MANIFEST_REPO_GIT_URL ?? DEFAULT_REPO_URL;
const reuseDir = process.env.MANIFEST_REPO_DIR;
const workDir = reuseDir ?? mkdtempSync(join(tmpdir(), "blisswork-update-manifest-"));
const cleanupOnExit = !reuseDir;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
}

try {
  if (reuseDir) {
    if (!existsSync(join(reuseDir, ".git"))) {
      console.error(`✗ MANIFEST_REPO_DIR=${reuseDir} is not a git checkout.`);
      process.exit(1);
    }
    git(["fetch", "origin"], workDir);
    git(["reset", "--hard", "origin/HEAD"], workDir);
  } else {
    console.log(`\nCloning ${repoUrl}…`);
    execFileSync("git", ["clone", "--depth", "1", repoUrl, workDir], { stdio: "inherit" });
  }

  const manifestPath = join(workDir, "manifest.json");
  const before = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  const after = JSON.stringify(manifest, null, 2) + "\n";
  if (before === after) {
    console.log("\nmanifest.json already up to date — nothing to publish.");
    process.exit(0);
  }
  writeFileSync(manifestPath, after);

  git(["add", "manifest.json"], workDir);
  git(
    [
      "-c", "user.name=BlissWork Release",
      "-c", "user.email=noreply@anthropic.com",
      "commit", "-m", `Publish update manifest for ${version}`,
    ],
    workDir,
  );
  git(["push", "origin", "HEAD"], workDir);
  console.log(`\n✓ published manifest.json for version ${version}`);
} finally {
  if (cleanupOnExit) rmSync(workDir, { recursive: true, force: true });
}
