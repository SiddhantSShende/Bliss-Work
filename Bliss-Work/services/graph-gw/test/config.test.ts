/**
 * The gateway's two safety switches must be impossible to leave on in
 * production. Both default off; both refuse to boot production when set.
 *
 * Tested rather than trusted because the failure is invisible: a gateway that
 * accepts arbitrary documents serves every request correctly while quietly
 * exposing a far larger surface than the one that was reviewed.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { AUTH_BASE, MESSAGING_BASE } from "./helpers.js";

const BASES = { AUTH_BASE, MESSAGING_BASE } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("defaults both guards to off", () => {
    const cfg = loadConfig({ ...BASES });
    expect(cfg.allowArbitraryQueries).toBe(false);
    expect(cfg.introspection).toBe(false);
  });

  it("refuses to boot production with arbitrary queries enabled", () => {
    expect(() =>
      loadConfig({ ...BASES, NODE_ENV: "production", GRAPHQL_ALLOW_ARBITRARY_QUERIES: "true" }),
    ).toThrow(ConfigError);
  });

  it("refuses to boot production with introspection enabled", () => {
    expect(() =>
      loadConfig({ ...BASES, NODE_ENV: "production", GRAPHQL_INTROSPECTION: "true" }),
    ).toThrow(ConfigError);
  });

  it("allows both outside production, which is what they are for", () => {
    const cfg = loadConfig({
      ...BASES,
      NODE_ENV: "development",
      GRAPHQL_ALLOW_ARBITRARY_QUERIES: "true",
      GRAPHQL_INTROSPECTION: "true",
    });
    expect(cfg.allowArbitraryQueries).toBe(true);
    expect(cfg.introspection).toBe(true);
  });

  it.each(["1", "yes", "TRUE", "on", ""])("reads %j as off, so a typo fails safe", (value) => {
    expect(loadConfig({ ...BASES, GRAPHQL_ALLOW_ARBITRARY_QUERIES: value }).allowArbitraryQueries)
      .toBe(false);
  });

  it("requires upstream bases in production rather than defaulting to localhost", () => {
    // A prod gateway pointed at localhost is a broken deploy that looks healthy
    // until the first query.
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
  });

  it("keeps the upstream deadline below the browser client's own 30s timeout", () => {
    // If the gateway were slower, the client would give up on the whole query
    // rather than receive the partial result the gateway builds.
    expect(loadConfig({ ...BASES }).upstreamTimeoutMs).toBeLessThan(30_000);
  });

  it("keeps the shutdown grace above the upstream deadline", () => {
    // Otherwise a rolling deploy cuts requests still waiting on a legitimately
    // slow upstream.
    const cfg = loadConfig({ ...BASES });
    expect(cfg.shutdownGraceMs).toBeGreaterThan(cfg.upstreamTimeoutMs);
  });

  it("rejects a non-numeric timeout instead of silently using the default", () => {
    expect(() => loadConfig({ ...BASES, UPSTREAM_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
  });

  it("strips a trailing slash so path joins cannot produce a double slash", () => {
    expect(loadConfig({ ...BASES, AUTH_BASE: "http://auth-svc:8001/" }).authBase)
      .toBe("http://auth-svc:8001");
  });
});
