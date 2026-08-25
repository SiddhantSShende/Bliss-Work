import { defineConfig } from "vitest/config";

/**
 * `__BROWSER__` is normally substituted by esbuild's `define` at build time
 * (see build.mjs) — one literal per target, never a runtime branch. Under
 * vitest, background.ts is imported directly (no esbuild bundling step), so
 * the same substitution has to happen here or the global is simply undefined.
 *
 * Fixed at "chrome" for the whole test run rather than parameterized per
 * target: background.test.ts's assertions are about the SHARED sampling/
 * batching logic (which every target's bundle runs unmodified), not about
 * which literal string a given build stamps into `detail.browser` — that
 * one-line substitution is proven correct by build.mjs actually running
 * (see docs/BROWSERS.md's "what was verified" section), not by a unit test
 * re-asserting what esbuild's `define` already guarantees.
 */
export default defineConfig({
  define: {
    __BROWSER__: JSON.stringify("chrome"),
  },
});
