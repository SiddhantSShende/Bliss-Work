/**
 * Bundle the extension into dist/ (or dist-<target>/), ready to load unpacked
 * or zip for a store.
 *
 *   npm run build -w @taskboard/extension                # Chromium -> dist/
 *   npm run build:firefox -w @taskboard/extension         # Firefox -> dist-firefox/
 *
 * esbuild rather than Vite: there is no dev server, no HMR and no framework —
 * two entry points and a manifest. The MV3 service worker must be a real ES
 * module with no dynamic requires, which is exactly esbuild's default output.
 *
 * ── One source, one bundle, per-target MANIFEST only ─────────────────────────
 * `src/background.ts`, `src/tracker.ts`, `src/siteEnrichment.ts` and
 * `src/options.ts` are IDENTICAL across every target this script builds.
 * Chrome, Edge and Brave (all Chromium, all already MV3-compatible at the
 * chrome116 language target) need no branching at all — they share the
 * Chromium manifest and this single bundle unmodified. Firefox needs the SAME
 * bundle too: it supports every `chrome.*` API this extension calls
 * (including Promise-based `chrome.*` as of recent Firefox MV3 support — see
 * docs/BROWSERS.md), so no `browser.*` shim and no webextension-polyfill are
 * needed. The ONLY thing that differs per target is the manifest — Firefox
 * needs `background.scripts` instead of `background.service_worker` and a
 * `browser_specific_settings.gecko` block, which Chromium's validator does
 * not recognise and Firefox's requires. That is the entire browser-specific
 * surface, and it is isolated to plain JSON, never to a branch in the bundled
 * TypeScript.
 *
 * Safari is NOT a target of this script. It needs a native wrapper app built
 * via Xcode's `safari-web-extension-converter`, which is a distinct build
 * pipeline outside esbuild's reach entirely — see docs/BROWSERS.md's Safari
 * section for why, and what that pipeline consumes FROM this bundle (the
 * `dist/` Chromium output is the starting point the converter ingests).
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const TARGETS = {
  chromium: {
    // Chrome, Edge, Brave, and any other Chromium browser at this baseline —
    // one manifest for all three because they share ONE extension platform.
    // Naming this "chrome" would misstate that: Edge and Brave load this
    // exact file unmodified, not a compatibility shim of it.
    manifest: "manifest.json",
    outDir: "dist",
    esbuildTarget: "chrome116",
    browserConstant: "chrome",
  },
  firefox: {
    manifest: "manifest.firefox.json",
    outDir: "dist-firefox",
    // Firefox's own JS engine support is well ahead of chrome116-equivalent
    // syntax; esbuild has no "firefoxNNN" target for MV3-era Firefox, so this
    // targets the same baseline the Chromium build already assumes. The
    // manifest's strict_min_version (115.0) is the real compatibility floor —
    // this target string only affects syntax lowering, not API availability.
    esbuildTarget: "chrome116",
    browserConstant: "firefox",
  },
};

const targetArg = (process.argv.find((a) => a.startsWith("--target=")) ?? "--target=chromium")
  .slice("--target=".length);
const target = TARGETS[targetArg];
if (!target) {
  console.error(`Unknown --target=${targetArg}. Valid targets: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const manifestPath = join(root, target.manifest);
if (!existsSync(manifestPath)) {
  console.error(`Missing manifest for target "${targetArg}": ${target.manifest}`);
  process.exit(1);
}

const out = join(root, target.outDir);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "src/background.ts"), join(root, "src/options.ts")],
  outdir: out,
  bundle: true,
  format: "esm",
  target: target.esbuildTarget,
  minify: true,
  // No sourcemaps in the shipped package: they would embed the full source in a
  // store upload for no user benefit.
  sourcemap: false,
  // The ONE per-target substitution in the bundled JS — everything else that
  // differs between targets lives in the manifest, copied below unmodified.
  define: { __BROWSER__: JSON.stringify(target.browserConstant) },
});

cpSync(manifestPath, join(out, "manifest.json"));
cpSync(join(root, "options.html"), join(out, "options.html"));
cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });

// Chromium-only: the manifest's `storage.managed_schema` key points at this
// file, and Chrome refuses to load an extension that declares it and cannot
// find it. Firefox's manifest does not declare this key at all — its managed-
// storage provisioning is a different mechanism entirely (a native-manifest
// JSON file or the enterprise `3rdparty` policy, not managed_schema — see
// docs/BROWSERS.md) — so shipping this file into a Firefox build would be
// dead weight implying a capability that manifest does not use.
if (targetArg === "chromium") {
  cpSync(join(root, "managed-schema.json"), join(out, "managed-schema.json"));
}

console.log(`extension built (${targetArg}) -> apps/extension/${target.outDir}`);
