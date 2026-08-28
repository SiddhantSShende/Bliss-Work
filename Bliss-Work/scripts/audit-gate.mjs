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
  // ── tar (12 advisories) ──────────────────────────────────────────────────
  // `npm ls tar` (2026-08-28) traces every copy to @taskboard/desktop's native-
  // module build tooling: electron-builder's own tar@7.5.19 (already the fixed
  // line — not one of these advisories) and get-windows's install-time chain
  // (@mapbox/node-pre-gyp, node-gyp → tar@6.2.1, the vulnerable one). None of
  // it ships in the packaged app or runs in any deployed service; it only runs
  // on the build machine during `npm install`/`electron-builder`, extracting
  // prebuilt binaries get-windows fetches from its own GitHub releases — never
  // an attacker-supplied archive, which every one of these CVEs requires
  // (symlink/hardlink path traversal, decompression DoS, etc., all specific to
  // EXTRACTING a malicious .tar). Forcing tar@7 via an npm `overrides` was
  // considered and rejected: node-gyp/node-pre-gyp are not verified compatible
  // with tar's v7 API and this is exactly the desktop build this session spent
  // real effort getting green — not worth risking to silence an unreachable
  // build-time-only advisory.
  ...[
    ["GHSA-34x7-hfp2-rc4v", "Arbitrary File Creation/Overwrite via Hardlink Path Traversal"],
    ["GHSA-8qq5-rm4j-mr97", "Arbitrary File Overwrite and Symlink Poisoning via Insufficient Path Sanitization"],
    ["GHSA-83g3-92jg-28cx", "Arbitrary File Read/Write via Hardlink Target Escape Through Symlink Chain"],
    ["GHSA-qffp-2rhf-9h96", "Hardlink Path Traversal via Drive-Relative Linkpath"],
    ["GHSA-9ppj-qmqm-q256", "Symlink Path Traversal via Drive-Relative Linkpath"],
    ["GHSA-r6q2-hw4h-h46w", "Race Condition in Path Reservations via Unicode Ligature Collisions on macOS APFS"],
    ["GHSA-vmf3-w455-68vh", "PAX size override causes tar parser interpretation differential (file smuggling)"],
    ["GHSA-w8wr-v893-vjvp", "Process crash via PAX numeric path type confusion"],
    ["GHSA-23hp-3jrh-7fpw", "Decompression/parse DoS via unlimited input"],
    ["GHSA-8x88-c5mf-7j5w", "Negative tar entry size causes infinite loop in archive replace"],
    ["GHSA-gvwx-54wh-qm9j", "Uncaught Exception DoS via NUL byte in PAX path/linkpath records"],
    ["GHSA-r292-9mhp-454m", "Uncontrolled recursion in mapHas/filesFilter — stack-overflow DoS via crafted long-path tar"],
  ].map(([id, title]) => ({
    id,
    package: "tar",
    why: `${title} — build-time-only dependency chain, see the block comment above.`,
    notAffected:
      "Reached only by node-gyp/node-pre-gyp extracting get-windows's own prebuilt " +
      "binaries from its GitHub releases during `npm install`; never an attacker-" +
      "supplied archive, and never executed by any deployed service or the packaged app.",
    reviewBy: "2026-10-01",
  })),
  // ── OpenTelemetry (2 advisories, both DoS via malformed HTTP input) ──────
  // Both are transitive dependencies of @taskboard/graph-gw's
  // @opentelemetry/sdk-node. Verified against services/graph-gw/src/tracing.ts
  // (2026-08-28): it dynamically imports only sdk-node, exporter-trace-otlp-
  // grpc, instrumentation-http, resources and semantic-conventions to build an
  // OTLP/gRPC trace exporter — it never imports or instantiates
  // PrometheusExporter or JaegerPropagator. Unimported code never runs, so
  // these two are unreachable regardless of what reaches the process over the
  // network. (Tracing itself is also gated on OTEL_EXPORTER_OTLP_ENDPOINT being
  // set at all — a second, independent reason the vulnerable code never loads
  // when it's unset.)
  {
    id: "GHSA-q7rr-3cgh-j5r3",
    package: "@opentelemetry/exporter-prometheus / @opentelemetry/sdk-node",
    why: "Prometheus exporter process crash via malformed HTTP request — fix requires a semver-major sdk-node bump (0.57.2 → 0.221.0) with unverified API compatibility.",
    notAffected: "PrometheusExporter is never imported by graph-gw — see the block comment above.",
    reviewBy: "2026-10-01",
  },
  {
    id: "GHSA-45rx-2jwx-cxfr",
    package: "@opentelemetry/propagator-jaeger",
    why: "JaegerPropagator DoS via malformed header — same semver-major sdk-node bump required as GHSA-q7rr-3cgh-j5r3.",
    notAffected: "JaegerPropagator is never imported by graph-gw — see the block comment above.",
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
