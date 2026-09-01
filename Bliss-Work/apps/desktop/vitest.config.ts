import { defineConfig } from "vitest/config";

/**
 * Test config for the desktop app's MAIN-process code.
 *
 * This package had no config at all until the desktop sticky notes regressed
 * twice without a single test noticing. Vitest's defaults very nearly work
 * here, but two things need saying out loud:
 *
 *   * `include` is scoped to `src/`. `out/` and `release/` hold BUILT output —
 *     a bundled copy of these same modules — and are not excluded by Vitest's
 *     defaults the way `dist/` is. Left alone, a build before a test run would
 *     collect every suite twice, once against source and once against a stale
 *     bundle that no longer matches it.
 *   * `environment: "node"`. Everything under src/main is main-process code
 *     that talks to Electron and the filesystem; a jsdom global would only
 *     make a browser-shaped mistake typecheck.
 *
 * Electron itself is not available under Vitest (there is no Electron runtime
 * here, only Node), so any suite touching it mocks the module — see
 * src/test/electron-mock.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
