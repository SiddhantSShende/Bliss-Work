import { defineConfig } from "vitest/config";

/**
 * Test config for packages/app — the whole React app.
 *
 * Until now this package had NO DOM environment, so every test had to live in a
 * pure module and not one component was covered. That is why the optimistic
 * mention logic was extracted into `lib/mentionPatch.ts`: it was the only
 * testable seam available.
 *
 * `environment: "jsdom"` applies to every test here. The pure modules
 * (mentionPatch, inboxPatch, refresh, …) don't need it and are unaffected —
 * jsdom setup costs a few ms per file, which is not worth splitting the config
 * into two projects to avoid.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    // Registers @testing-library/jest-dom matchers and auto-cleans the DOM
    // between tests — without cleanup, a component from one test is still
    // mounted during the next and queries match the wrong element.
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // A component test that hangs (an unresolved promise in a query) should
    // fail fast rather than sit until the CI job times out.
    testTimeout: 10_000,
  },
});
