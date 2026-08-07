#!/usr/bin/env node
/**
 * The website and the web app must offer the SAME desktop installers, and those
 * names must match what electron-builder actually produces.
 *
 * WHY THIS EXISTS. Three copies of the same list drift apart silently:
 *   1. apps/desktop/package.json  build.<os>.artifactName  — what is BUILT
 *   2. packages/app/src/lib/downloads.ts                   — the WEB APP's links
 *   3. Bliss-Website/src/config/downloads.ts               — the WEBSITE's links
 * (2) and (3) live in different repos and are kept in sync by nothing but a
 * comment in each saying "keep in sync". A filename change in (1) 404s both; a
 * change in one of (2)/(3) silently gives the two surfaces different downloads.
 *
 * Rather than diff two repos (CI for one can't see the other), this pins every
 * copy to (1), which is the only thing that decides what actually lands on the
 * download host. Anything pinned to the same source of truth cannot drift from
 * anything else pinned to it.
 *
 * Usage:
 *   node scripts/check-download-links.mjs
 *   node scripts/check-download-links.mjs --website ../Bliss-Website
 *   node scripts/check-download-links.mjs --live
 *
 * --website  also validates the marketing site's copy (run it from a checkout
 *            that has both repos side by side, or in the website's own CI).
 * --live     fetches both public hosts and asserts they serve the same bytes.
 *            Network-dependent, so it is opt-in rather than part of the default.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const websiteArg = args.includes("--website") ? args[args.indexOf("--website") + 1] : null;
const doLive = args.includes("--live");

const problems = [];

// ── What the desktop build actually produces ────────────────────────────────
// Expand build.<os>.artifactName over each target/arch pair. These are the only
// filenames that will ever exist on the download host.
const build = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).build;

/** Installers a HUMAN downloads. The mac .zip targets exist only so
 *  electron-updater has something to fetch, and are deliberately not offered as
 *  download links — but they must still be published (release.yml checks that). */
const USER_FACING_EXT = new Set(["exe", "dmg", "AppImage", "deb"]);

const produced = new Set();
const updaterOnly = new Set();
for (const os of ["win", "mac", "linux"]) {
  const cfg = build[os];
  if (!cfg?.artifactName) {
    problems.push(`apps/desktop/package.json: build.${os}.artifactName is not set`);
    continue;
  }
  for (const t of cfg.target ?? []) {
    // electron-builder's ${ext} is the target name, except nsis → exe.
    const ext = t.target === "nsis" ? "exe" : t.target;
    for (const arch of t.arch ?? ["x64"]) {
      const name = cfg.artifactName.replace("${arch}", arch).replace("${ext}", ext);
      (USER_FACING_EXT.has(ext) ? produced : updaterOnly).add(name);
    }
  }
}

// ── What each surface links to ──────────────────────────────────────────────
function linkedNames(file, label) {
  if (!existsSync(file)) {
    problems.push(`${label}: not found at ${file}`);
    return null;
  }
  const src = readFileSync(file, "utf8");
  const names = new Set([...src.matchAll(/\/(BlissWork-[A-Za-z0-9._-]+)/g)].map((m) => m[1]));
  if (names.size === 0) {
    problems.push(`${label}: no BlissWork-* download URLs found — did the file's shape change?`);
    return null;
  }
  return names;
}

function compare(names, label) {
  if (!names) return;
  for (const want of produced) {
    if (!names.has(want)) {
      problems.push(
        `${label}: does not link "${want}", which the desktop build produces — ` +
          `that platform has no download link`,
      );
    }
  }
  for (const got of names) {
    if (produced.has(got)) continue;
    if (updaterOnly.has(got)) {
      problems.push(
        `${label}: links "${got}", which is an auto-update artifact, not a user download`,
      );
    } else {
      problems.push(
        `${label}: links "${got}", which the desktop build never produces — this URL 404s`,
      );
    }
  }
}

const webApp = linkedNames(join(root, "packages/app/src/lib/downloads.ts"), "web app");
compare(webApp, "web app");

let website = null;
if (websiteArg) {
  const p = join(websiteArg, "src/config/downloads.ts");
  website = linkedNames(p, "website");
  compare(website, "website");

  // Belt and braces: if both are readable, assert they agree with each other
  // directly, not just with the build config.
  if (webApp && website) {
    for (const n of webApp) {
      if (!website.has(n)) problems.push(`website is missing "${n}" that the web app offers`);
    }
    for (const n of website) {
      if (!webApp.has(n)) problems.push(`web app is missing "${n}" that the website offers`);
    }
  }
}

console.log(`desktop build produces ${produced.size} user-facing installer(s):`);
for (const n of [...produced].sort()) console.log(`  · ${n}`);
if (updaterOnly.size) {
  console.log(`plus ${updaterOnly.size} updater-only artifact(s): ${[...updaterOnly].sort().join(", ")}`);
}

// ── Optional: do the two public hosts actually serve the same thing? ─────────
if (doLive) {
  const HOSTS = {
    "web app": "https://communication.rnrtechs.com/downloads",
    website: "https://blisswork.rnrtechs.com/downloads",
  };
  const MIN_BYTES = 5 * 1024 * 1024;
  console.log("\nlive check:");
  for (const name of [...produced].sort()) {
    const sizes = {};
    for (const [label, base] of Object.entries(HOSTS)) {
      const res = await fetch(`${base}/${name}`, { method: "HEAD" }).catch(() => null);
      sizes[label] = res?.ok ? Number(res.headers.get("content-length") ?? 0) : null;
    }
    const [a, b] = Object.values(sizes);
    if (a === null || b === null) {
      problems.push(`${name}: not served by ${a === null ? "the web app" : "the website"}`);
    } else if (a !== b) {
      problems.push(`${name}: web app serves ${a} bytes, website serves ${b} — DIFFERENT files`);
    } else if (a < MIN_BYTES) {
      problems.push(
        `${name}: both hosts serve ${a} bytes — that is a placeholder, not an installer. ` +
          `Every user on this platform downloads a broken file.`,
      );
    } else {
      console.log(`  ok  ${name.padEnd(32)} ${a} bytes on both hosts`);
    }
  }
}

if (problems.length) {
  console.error("\nDownload link checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nThe website and the web app must offer the same installers, and those names\n" +
      "must match apps/desktop/package.json build.<os>.artifactName.\n",
  );
  process.exit(1);
}

console.log("\n✓ download links agree with what the desktop build produces");
