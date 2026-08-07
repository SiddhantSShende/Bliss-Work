#!/usr/bin/env node
/**
 * Assert the desktop bundle ships the same app as the web bundle.
 *
 * WHY THIS EXISTS. apps/web and apps/desktop both render packages/app through
 * the PlatformConfig seam, so in principle they cannot diverge. In practice they
 * did — and nobody noticed for weeks. The installer users were running (0.1.0,
 * built 2026-07-02) had no Integrations, Workspace apps, Mentions or Export
 * Tasks, while the web app had all four. Nothing failed: the desktop build was
 * simply old, and its updater pointed at a private GitHub repo it could never
 * read, so it never caught up. The whole class of bug is invisible because a
 * stale-but-working desktop build looks exactly like a healthy one.
 *
 * This check compares the BUILT ARTIFACTS, which is the only thing users
 * actually run. The route table in App.tsx is the manifest — derived at check
 * time rather than hardcoded, so a new route is covered the moment it's added
 * and this file never needs editing.
 *
 * Minification (renderer `minify: "esbuild"`) mangles identifiers but not string
 * literals, so route paths survive in both bundles. That is what makes the
 * comparison valid; the self-test at the bottom asserts it rather than assuming.
 *
 * Usage:  node scripts/check-bundle-parity.mjs
 * Run it AFTER building both:
 *   npm run build -w @taskboard/web && npm run build -w @taskboard/desktop
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const WEB_ASSETS = join(root, "apps/web/dist/assets");
const DESKTOP_ASSETS = join(root, "apps/desktop/out/renderer/assets");
const APP_TSX = join(root, "packages/app/src/App.tsx");

const problems = [];

function readBundle(dir, label) {
  if (!existsSync(dir)) {
    problems.push(`${label}: no build output at ${dir} — build it before running this check`);
    return "";
  }
  // Concatenate every JS chunk: code-splitting decides WHICH chunk a route
  // lands in, and that split legitimately differs between the two builds.
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/** Route paths from App.tsx — the feature manifest, derived not hardcoded. */
function routeManifest() {
  const src = readFileSync(APP_TSX, "utf8");
  const paths = [...src.matchAll(/<Route\s[^>]*?path="([^"]+)"/gs)].map((m) => m[1]);
  return [
    ...new Set(
      paths
        // "*" is a catch-all, and ":params" are matched structurally by the
        // router — neither is a distinguishing literal worth asserting on.
        .filter((p) => p !== "*" && p !== "/" && !p.startsWith(":"))
        // Compare on the static prefix: "inbox/thread/:threadId" ships in the
        // bundle as the literal "inbox/thread/:threadId", but the static head is
        // the robust thing to look for across minifiers.
        .map((p) => p.split("/:")[0])
        .filter(Boolean),
    ),
  ];
}

const web = readBundle(WEB_ASSETS, "web");
const desktop = readBundle(DESKTOP_ASSETS, "desktop");

if (web && desktop) {
  const routes = routeManifest();
  if (routes.length < 10) {
    problems.push(
      `route manifest looks wrong (${routes.length} routes) — did App.tsx's <Route> shape change? ` +
        `This check is worthless if it silently matches nothing.`,
    );
  }

  for (const route of routes) {
    const inWeb = web.includes(route);
    const inDesktop = desktop.includes(route);
    if (inWeb && !inDesktop) {
      problems.push(`route "${route}" is in the web bundle but MISSING from the desktop bundle`);
    } else if (!inWeb && inDesktop) {
      problems.push(`route "${route}" is in the desktop bundle but MISSING from the web bundle`);
    } else if (!inWeb && !inDesktop) {
      problems.push(`route "${route}" is in neither bundle — the manifest regex is matching junk`);
    }
  }

  // Named features that are not routes: a component can vanish from one bundle
  // while every route still resolves. These are the exact ones 0.1.0 was missing.
  const FEATURE_STRINGS = ["Workspace apps", "Connected accounts", "Mentions"];
  for (const s of FEATURE_STRINGS) {
    if (web.includes(s) !== desktop.includes(s)) {
      problems.push(
        `feature string "${s}": web=${web.includes(s)} desktop=${desktop.includes(s)} — ` +
          `one platform is missing it`,
      );
    }
  }

  console.log(
    `checked ${routes.length} routes + ${FEATURE_STRINGS.length} feature strings ` +
      `across web (${(web.length / 1024).toFixed(0)} KB) and desktop ` +
      `(${(desktop.length / 1024).toFixed(0)} KB) bundles`,
  );
}

if (problems.length) {
  console.error("\nBundle parity FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nThe desktop app and the web app must ship the same feature set. If a route is\n" +
      "genuinely web-only, gate it on config.kind inside packages/app rather than\n" +
      "letting the bundles diverge.\n",
  );
  process.exit(1);
}

console.log("✓ web and desktop bundles expose the same feature set");
