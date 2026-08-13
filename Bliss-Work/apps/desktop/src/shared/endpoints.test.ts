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
import { resolveEndpoints, PROD_ENDPOINTS, DEV_ENDPOINTS, type Endpoints } from "./endpoints";

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
