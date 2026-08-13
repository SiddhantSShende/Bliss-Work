#!/usr/bin/env node
/**
 * Every installer this site links to must actually exist and be a real file.
 *
 * WHY THIS EXISTS. src/config/downloads.ts is a hand-maintained copy of the same
 * list in Bliss-Work (packages/app/src/lib/downloads.ts), kept in sync by
 * nothing but a comment in each file. The two repos are separate, so neither
 * CI can see the other's copy — which is exactly how the two "Get the App"
 * buttons end up offering different things.
 *
 * This repo can't read Bliss-Work's electron-builder config, so it checks the
 * next best thing, which is arguably the more important one: that every URL
 * this site hands a visitor resolves to a plausible installer on BOTH download
 * hosts. That catches a rename in the desktop build, a missed sync, and a
 * failed upload — without needing the other repo checked out.
 *
 * It is also how we would have caught the mac .dmg files sitting on the download
 * host as 128-byte text placeholders reading "Please replace this file with the
 * actual installer on the VPS" — served to every Mac visitor, from both hosts,
 * for weeks, with the page looking completely normal.
 *
 * Usage:  node scripts/check-download-links.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const HOSTS = {
  website: "https://blisswork.rnrtechs.com/downloads",
  "web app": "https://communication.rnrtechs.com/downloads",
};
/** Installers are ~100 MB. Anything under this is a stub or a truncated upload. */
const MIN_BYTES = 5 * 1024 * 1024;

const src = readFileSync(join(root, "src/config/downloads.ts"), "utf8");
const names = [...new Set([...src.matchAll(/\/(BlissWork-[A-Za-z0-9._-]+)/g)].map((m) => m[1]))].sort();

const problems = [];

if (names.length === 0) {
  problems.push("no BlissWork-* download URLs found in src/config/downloads.ts — did its shape change?");
}

for (const name of names) {
  const sizes = {};
  for (const [label, base] of Object.entries(HOSTS)) {
    const res = await fetch(`${base}/${name}`, { method: "HEAD" }).catch(() => null);
    sizes[label] = res?.ok ? Number(res.headers.get("content-length") ?? 0) : null;
  }
  const missing = Object.entries(sizes).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) {
    problems.push(`${name}: not served by ${missing.join(" or ")} — this download link 404s`);
    continue;
  }
  const [a, b] = Object.values(sizes);
  if (a !== b) {
    problems.push(
      `${name}: the two hosts serve different files (${a} vs ${b} bytes) — ` +
        `visitors get a different app depending on which page they came from`,
    );
  } else if (a < MIN_BYTES) {
    problems.push(
      `${name}: ${a} bytes on both hosts — that is a placeholder, not an installer`,
    );
  } else {
    console.log(`  ok  ${name.padEnd(32)} ${a} bytes on both hosts`);
  }
}

if (problems.length) {
  console.error("\nDownload link checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nInstallers are published by Bliss-Work's .github/workflows/release.yml.\n" +
      "If a filename changed there, update src/config/downloads.ts to match.\n",
  );
  process.exit(1);
}

console.log(`\n✓ all ${names.length} download links resolve identically on both hosts`);
