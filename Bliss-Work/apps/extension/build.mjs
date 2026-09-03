/**
 * Bundle the extension into dist/ (or dist-<target>/), ready to load unpacked
 * or zip for a store.
 *
 *   npm run build -w @taskboard/extension                # Chromium -> dist/
 *   npm run build:firefox -w @taskboard/extension         # Firefox -> dist-firefox/
 *
 * `dist/` doubles as the input to scripts/pack-crx.mjs's dist.crx/dist.zip,
 * so the plain `--target=chromium` build above always produces the manifest
 * that is safe to ship. Pass `--dev` (e.g. `node build.mjs --dev`) only to
 * test the automatic-provisioning handshake against a local web-app dev
 * server — see TARGETS.chromium's `devOnlyConnectableOrigins` comment below.
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
 * Safari's WEB EXTENSION half (the `dist-safari/` this script produces) IS
 * just a fourth manifest variant, the same as Firefox — Safari 14+/WebKit's
 * WebExtension implementation is `chrome.*`-API-compatible (tabs, storage,
 * alarms, idle — everything this extension actually calls), so no branching
 * exists in the bundled TypeScript for it either. What Safari needs BEYOND
 * this script is the native app-wrapper: an Xcode project with a Safari Web
 * Extension target whose `Resources/` directory is exactly this script's
 * `dist-safari/` output, built and code-signed via Xcode/xcodebuild — a
 * distinct pipeline outside esbuild's reach, same as Firefox's AMO signing is
 * outside it. See `xcode/` at the repo root of this package for that wrapper
 * project, and docs/BROWSERS.md's Safari section for what remains to be done
 * with it on a real Mac (this script cannot invoke Xcode).
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // `externally_connectable.matches` entries that exist ONLY to let a
    // developer test the automatic-provisioning handshake (background.ts's
    // `blisswork:provision`) against an unpacked build while running the web
    // app's local dev server — never something a real, shipped artifact may
    // contain. `dist/` is not only "what a developer loads unpacked": it is
    // also, byte-for-byte, what scripts/pack-crx.mjs signs into dist.crx/
    // dist.zip for real force-install. A well-known Vite dev port like
    // localhost:5173 is common enough on OTHER, unrelated local projects that
    // leaving it allowlisted in a shipped build would let any page on that
    // port silently repoint a real install's telemetry token (see
    // provisioning.ts) — so these origins are stripped from every build by
    // default and restored only with the explicit `--dev` flag below.
    devOnlyConnectableOrigins: ["http://localhost:5173/*"],
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
  safari: {
    manifest: "manifest.safari.json",
    // Feeds xcode/BlissWork Activity/BlissWork Activity Extension/Resources —
    // see that project's own README for how this output lands there (a copy,
    // not a symlink, so the Xcode project stays self-contained for someone
    // opening it without having run this script first).
    outDir: "dist-safari",
    // Safari's WebKit JS engine is not the target esbuild's syntax-lowering
    // needs to key on for correctness (WebKit has supported this syntax for
    // longer than Safari's own WebExtension API has existed) — chrome116 is
    // used as the same conservative, already-verified-safe baseline the
    // Firefox target reuses for the same reason.
    esbuildTarget: "chrome116",
    browserConstant: "safari",
  },
};

const targetArg = (process.argv.find((a) => a.startsWith("--target=")) ?? "--target=chromium")
  .slice("--target=".length);
const target = TARGETS[targetArg];
if (!target) {
  console.error(`Unknown --target=${targetArg}. Valid targets: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

// Opt-IN, not opt-out: a bare `npm run build` — the same command
// scripts/pack-crx.mjs's own docblock says to run before packing dist.crx —
// must always produce the safe, shippable manifest. `--dev` is for a
// developer who explicitly wants to test the automatic-provisioning handshake
// against a local web-app dev server (see TARGETS.chromium's own comment on
// `devOnlyConnectableOrigins`) and is loading the result unpacked, never
// packing or distributing it.
const devBuild = process.argv.includes("--dev");

const manifestPath = join(root, target.manifest);
if (!existsSync(manifestPath)) {
  console.error(`Missing manifest for target "${targetArg}": ${target.manifest}`);
  process.exit(1);
}

// The reserved `.example` TLD (RFC 2606) makes manifest.firefox.json's gecko id
// unmistakably a placeholder rather than something that could pass for a real
// one — see docs/BROWSERS.md's own note that it must be replaced before any AMO
// submission. `--strict` is what a real store-submission build passes (a local
// `about:debugging` load, which is the only use this repo's own workflow has
// for a Firefox build today, does not care what the id is); this is the one
// place that distinction is checked, so nobody has to remember it by hand at
// submission time.
if (targetArg === "firefox" && process.argv.includes("--strict")) {
  const geckoId = JSON.parse(readFileSync(manifestPath, "utf8"))
    .browser_specific_settings?.gecko?.id;
  if (typeof geckoId === "string" && geckoId.endsWith(".example")) {
    console.error(
      `manifest.firefox.json's gecko.id is still the placeholder ("${geckoId}"). ` +
      `Replace it with a real id (a domain BlissWork controls, or the id AMO ` +
      `assigns on first submission) before building for AMO submission. ` +
      `See docs/BROWSERS.md.`,
    );
    process.exit(1);
  }
}

/**
 * Copy `srcPath` to `destPath`, stripping this target's dev-only
 * `externally_connectable` origins unless `--dev` was passed. This is the
 * ONE place a shipped manifest is allowed to diverge from the one checked
 * into source, and it only ever REMOVES an entry, never adds one that isn't
 * already declared in the source manifest.
 */
function writeManifest(srcPath, destPath) {
  const devOnly = target.devOnlyConnectableOrigins;
  if (devBuild || !devOnly?.length) {
    cpSync(srcPath, destPath);
    return;
  }
  const manifest = JSON.parse(readFileSync(srcPath, "utf8"));
  const matches = manifest.externally_connectable?.matches;
  if (Array.isArray(matches)) {
    manifest.externally_connectable.matches = matches.filter((m) => !devOnly.includes(m));
  }
  writeFileSync(destPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  // differs between targets lives in the manifest, written below (verbatim,
  // except for the dev-only stripping writeManifest performs).
  define: { __BROWSER__: JSON.stringify(target.browserConstant) },
});

writeManifest(manifestPath, join(out, "manifest.json"));
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
