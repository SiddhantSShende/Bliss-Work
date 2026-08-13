#!/usr/bin/env node
/**
 * Print the next desktop version: the highest version currently PUBLISHED, with
 * its patch bumped.
 *
 *   node scripts/next-desktop-version.mjs [downloadsDir]
 *
 * Why derive it from what's published rather than from package.json: electron-
 * updater only offers an update when the feed's version is strictly greater
 * than the version the user is running. package.json has sat at 0.1.0 while the
 * feed moved to 0.1.1 and 0.1.3 (the old CI derived versions from a run number
 * and never committed them back), so building "the version in package.json"
 * would publish a release nobody is offered.
 *
 * Reads every latest*.yml in the downloads directory and takes the max, so the
 * platforms stay on one increasing line even when only one of them builds.
 *
 * Override anytime with DESKTOP_VERSION=1.2.3.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "/downloads";

if (process.env.DESKTOP_VERSION) {
  console.log(process.env.DESKTOP_VERSION.trim());
  process.exit(0);
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

let best = [0, 1, 0];
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => /^latest.*\.yml$/.test(f))) {
    const line = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .find((l) => l.startsWith("version:"));
    const got = line && parse(line.slice("version:".length).replace(/['"]/g, ""));
    if (got && (got[0] > best[0] || (got[0] === best[0] && (got[1] > best[1] || (got[1] === best[1] && got[2] > best[2]))))) {
      best = got;
    }
  }
}

// Patch bump. Minor/major are deliberate acts — pass DESKTOP_VERSION for those.
console.log(`${best[0]}.${best[1]}.${best[2] + 1}`);
