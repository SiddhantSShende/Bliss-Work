/**
 * Endpoint resolution.
 *
 * These values decide which backend a shipped installer talks to. Getting them
 * wrong is not a subtle bug — a packaged build pointed at localhost simply
 * cannot log anyone in, and there is no in-app way to correct it after release.
 *
 * The main process and the renderer each detect "is this production?" and read
 * overrides differently (`app.isPackaged` + `process.env` vs `import.meta.env`),
 * so the shared contract is exactly this function.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveEndpoints, resolveEndpointsFromEnv, PROD_ENDPOINTS, DEV_ENDPOINTS, type Endpoints } from "./endpoints";

const KEYS = Object.keys(PROD_ENDPOINTS) as (keyof Endpoints)[];

describe("resolveEndpoints", () => {
  it("uses the hosted backend for a packaged build", () => {
    expect(resolveEndpoints(true)).toEqual(PROD_ENDPOINTS);
  });

  it("uses the local compose stack in dev", () => {
    expect(resolveEndpoints(false)).toEqual(DEV_ENDPOINTS);
  });

  it("lets a TB_/VITE_ override win", () => {
    const r = resolveEndpoints(true, { authBase: "https://staging.example/api/auth" });
    expect(r.authBase).toBe("https://staging.example/api/auth");
    // …without disturbing the rest.
    expect(r.taskBase).toBe(PROD_ENDPOINTS.taskBase);
  });

  it.each([
    [undefined, "undefined"],
    ["", "empty string"],
  ])("falls through to the default when an override is %s (%s)", (value, _label) => {
    // An unset env var arrives as "" or undefined depending on the shell and
    // the bundler. Treating "" as a real override would produce a build that
    // requests `/api/auth` against `file://` and fails with no useful error.
    const r = resolveEndpoints(true, { authBase: value });
    expect(r.authBase).toBe(PROD_ENDPOINTS.authBase);
  });

  it("accepts an override for every key", () => {
    const overrides = Object.fromEntries(
      KEYS.map((k) => [k, `https://override.example/${k}`]),
    ) as Record<keyof Endpoints, string>;
    expect(resolveEndpoints(true, overrides)).toEqual(overrides);
  });

  it("never returns an empty value for any key", () => {
    // A blank endpoint fails at request time, far from the cause.
    for (const isProd of [true, false]) {
      const r = resolveEndpoints(isProd);
      for (const k of KEYS) expect(r[k]).toBeTruthy();
    }
  });
});

describe("production endpoints", () => {
  it("are all TLS", () => {
    for (const k of KEYS) {
      expect(PROD_ENDPOINTS[k]).toMatch(/^(https|wss):\/\//);
    }
  });

  it("all point at the same origin the web app uses", () => {
    // The CSP in src/renderer/index.html names this host explicitly, so an
    // endpoint on any other origin would be blocked at runtime by connect-src.
    for (const k of KEYS) {
      expect(PROD_ENDPOINTS[k]).toContain("communication.rnrtechs.com");
    }
  });

  it("uses a ws:// socket and http:// APIs in dev", () => {
    expect(DEV_ENDPOINTS.wsUrl.startsWith("ws://")).toBe(true);
    expect(DEV_ENDPOINTS.authBase.startsWith("http://localhost")).toBe(true);
  });
});

/**
 * Web and desktop must resolve the SAME set of endpoints from the SAME
 * overrides. They are one product; a key that is configurable on one platform
 * and baked on the other is a deployment that half-works.
 *
 * This is not theoretical. `telemetryBase` was absent from both desktop
 * override maps while the web entry passed it, so `VITE_TELEMETRY_BASE` moved
 * the web app's telemetry and left the desktop pointing at the default — the
 * member-activity screens failed on desktop only, which reads to a user as
 * "the desktop app is missing features".
 */
describe("web/desktop endpoint parity", () => {
  const KEYS: (keyof Endpoints)[] = [
    "authBase",
    "taskBase",
    "notificationBase",
    "messagingBase",
    "telemetryBase",
    "wsUrl",
  ];

  it("forwards every key through the required-record form", () => {
    const overrides = Object.fromEntries(
      KEYS.map((k) => [k, `https://override.example/${k}`]),
    ) as Record<keyof Endpoints, string | undefined>;

    expect(resolveEndpointsFromEnv(true, overrides)).toEqual(overrides);
  });

  it("falls back per key when an override is absent", () => {
    const overrides = Object.fromEntries(KEYS.map((k) => [k, undefined])) as Record<
      keyof Endpoints,
      string | undefined
    >;
    expect(resolveEndpointsFromEnv(true, overrides)).toEqual(PROD_ENDPOINTS);
  });

  it("names every endpoint in BOTH desktop entry points", () => {
    // The compiler already enforces this (resolveEndpointsFromEnv takes a full
    // Record), but only for as long as both call sites keep using that form.
    // This is what notices someone reaching back for the Partial one.
    for (const [file, envPrefix] of [
      ["../renderer/main.tsx", "VITE_"],
      ["../main/index.ts", "TB_"],
    ] as const) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, `${file} must use the required-record form`).toContain(
        "resolveEndpointsFromEnv(",
      );
      for (const key of KEYS) {
        expect(src, `${file} does not pass ${key} — ${envPrefix}* for it is inert`)
          .toContain(`${key}:`);
      }
    }
  });
});
