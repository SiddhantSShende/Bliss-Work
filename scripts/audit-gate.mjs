#!/usr/bin/env node
/**
 * npm-audit gate with an explicit, justified allowlist.
 *
 *   node scripts/audit-gate.mjs
 *
 * Plain `npm audit --audit-level=high --omit=dev` is all-or-nothing: either it
 * blocks CI on advisories that cannot be fixed and cannot be exploited here, or
 * it gets switched to non-blocking and stops protecting anything. Both are bad.
 *
 * This runs the same audit and fails on every high/critical advisory EXCEPT the
 * ones listed below, each of which carries a reason, the evidence, and a review
 * date. A new advisory — including a new one in an already-listed package —
 * fails the build, because the allowlist keys on the advisory, not the package.
 *
 * Adding an entry is a deliberate act that shows up in review. Removing one
 * when an upstream fix lands is the whole point of `reviewBy`.
 */
import { execSync } from "node:child_process";

/**
 * Accepted advisories. Each needs:
 *   why       — why it cannot be fixed right now
 *   notAffected — the EVIDENCE that this app doesn't hit the vulnerable path
 *   reviewBy  — when to re-check for an upstream fix
 */
const ALLOW = [
  {
    id: "GHSA-mh99-v99m-4gvg",
    package: "brace-expansion",
    why:
      "Reaches us only through exceljs → archiver → glob/minimatch. exceljs has " +
      "shipped no forward fix; npm's suggested 'fix' is a DOWNGRADE to exceljs 4.1.1. " +
      "A brace-expansion@5 override breaks ESLint, whose bundled minimatch@3 calls " +
      "the old CJS callable export.",
    notAffected:
      "None of archiver/glob/minimatch/brace-expansion appears in ANY built chunk — " +
      "exceljs resolves to its prebuilt browser bundle (package.json `browser` field), " +
      "which excludes the Node-only zip path. Verified by grepping apps/web/dist.",
    reviewBy: "2026-10-01",
  },
  {
    id: "GHSA-rgw5-rvv9-x895",
    package: "brace-expansion",
    why:
      "Follow-up advisory to GHSA-mh99-v99m-4gvg above (it bypasses that CVE's " +
      "mitigation) — same package, same path, same blockers. Two vulnerable copies " +
      "resolve: 1.1.16 under archiver-utils → glob@7 → minimatch@3, which has NO " +
      "fixed 1.x (the range is <=1.1.17, and 1.1.17 is the last 1.x), and 5.0.8 at " +
      "the root. Forcing the fixed ^5.0.9 everywhere breaks minimatch@3, which " +
      "`require()`s brace-expansion as a callable — verified: the v5 export is a " +
      "plain object, not a function.",
    notAffected:
      "Same evidence as GHSA-mh99-v99m-4gvg, re-verified against a fresh build: " +
      "grep of apps/web/dist/assets/*.js finds no brace-expansion / archiver-utils " +
      "in any chunk. exceljs is imported only by packages/app/src/lib/xlsxExport.ts " +
      "(browser-only, resolves to the prebuilt browser bundle, which excludes the " +
      "Node zip path); no server-side or script code imports exceljs.",
    reviewBy: "2026-10-01",
  },
  {
    id: "GHSA-qwww-vcr4-c8h2",
    package: "react-router",
    why:
      "Fixed in react-router 8.3.0, but react-router-dom has NO 8.x line — v8 " +
      "consolidated the packages, so this is a migration, not a version bump. " +
      "Not something to land alongside unrelated work.",
    notAffected:
      "The advisory is an RSC-mode CSRF bypass. This app is a client-side SPA using " +
      "BrowserRouter/HashRouter (packages/app/src/App.tsx); it uses no RSC APIs, no " +
      "server-side router, and no router actions.",
    reviewBy: "2026-10-01",
  },
];

const allowedIds = new Set(ALLOW.map((a) => a.id));

let report;
try {
  // npm audit exits non-zero when it finds anything — that's the signal we're
  // parsing, not an error, so capture stdout regardless.
  report = execSync("npm audit --omit=dev --json", {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (e) {
  report = e.stdout;
}

if (!report) {
  console.error("audit-gate: npm audit produced no output");
  process.exit(1);
}

const data = JSON.parse(report);
const vulns = Object.values(data.vulnerabilities ?? {});

const blocking = [];
const waived = [];

for (const v of vulns) {
  if (!["high", "critical"].includes(v.severity)) continue;
  for (const via of v.via) {
    if (typeof via !== "object") continue; // a string `via` is a transitive pointer
    const id = via.url?.split("/").pop() ?? via.source;
    if (allowedIds.has(id)) {
      waived.push({ id, name: v.name, title: via.title });
    } else {
      blocking.push({ id, name: v.name, severity: v.severity, title: via.title });
    }
  }
}

for (const w of waived) {
  const entry = ALLOW.find((a) => a.id === w.id);
  console.log(`~ waived  ${w.name} (${w.id}) — review by ${entry.reviewBy}`);
}

// An allowlist entry that no longer matches anything is stale: the advisory was
// fixed or the dependency dropped. Say so rather than letting it rot.
const stale = ALLOW.filter((a) => !waived.some((w) => w.id === a.id));
for (const s of stale) {
  console.log(`! stale allowlist entry: ${s.package} (${s.id}) no longer reported — remove it`);
}

if (blocking.length === 0) {
  console.log(`\naudit-gate: OK (${waived.length} waived, 0 blocking)`);
  process.exit(0);
}

console.error(`\naudit-gate: ${blocking.length} unwaived high/critical advisory(ies):\n`);
for (const b of blocking) {
  console.error(`  ${b.severity.padEnd(8)} ${b.name} — ${b.title ?? "(no title)"}`);
  console.error(`           ${b.id}`);
}
console.error(
  "\nFix it, or add it to ALLOW in scripts/audit-gate.mjs with a reason,\n" +
    "evidence that this app is not affected, and a review date.",
);
process.exit(1);
