/**
 * Bundle the extension into dist/, ready to load unpacked or zip for a store.
 *
 *   npm run build -w @taskboard/extension
 *
 * esbuild rather than Vite: there is no dev server, no HMR and no framework —
 * two entry points and a manifest. The MV3 service worker must be a real ES
 * module with no dynamic requires, which is exactly esbuild's default output.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "src/background.ts"), join(root, "src/options.ts")],
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  // No sourcemaps in the shipped package: they would embed the full source in a
  // store upload for no user benefit.
  sourcemap: false,
});

cpSync(join(root, "manifest.json"), join(out, "manifest.json"));
cpSync(join(root, "options.html"), join(out, "options.html"));
cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });

console.log("extension built -> apps/extension/dist");
