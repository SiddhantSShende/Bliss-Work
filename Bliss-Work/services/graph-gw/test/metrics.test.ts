/**
 * Metrics. Two things are asserted rather than eyeballed:
 *
 *   1. The series the platform's existing dashboards read (`http_requests_total`,
 *      `http_request_duration_seconds`) exist with those exact names, so a panel
 *      written against the Go services works here without a second query.
 *   2. `graphql_loader_batch_size` moves with the batch, because it is the only
 *      production signal that would catch the gateway regressing into an N+1.
 */
import { describe, expect, it, vi } from "vitest";
import { Metrics } from "../src/metrics.js";
import { Upstream } from "../src/upstream.js";
import { createLoaders } from "../src/loaders.js";
import { CALLER, jsonResponse, testConfig, U, userRow } from "./helpers.js";

describe("Metrics", () => {
  it("exposes the platform-standard HTTP series under their shared names", async () => {
    const metrics = new Metrics();
    metrics.httpRequests.inc({ method: "GET", path: "/graphql", status: "200" });
    metrics.httpDuration.observe({ method: "GET", path: "/graphql" }, 0.02);

    const text = await metrics.render();
    expect(text).toContain("http_requests_total");
    expect(text).toContain("http_request_duration_seconds");
  });

  it("exposes process health, which is what moves first under load", async () => {
    // A gateway whose whole job is fanning out I/O shows trouble as event-loop
    // lag long before it shows it as errors.
    const text = await new Metrics().render();
    expect(text).toContain("graph_gw_nodejs_eventloop_lag_seconds");
  });

  it("renders in the Prometheus text format", async () => {
    const metrics = new Metrics();
    expect(metrics.contentType).toContain("text/plain");
    expect(await metrics.render()).toMatch(/# HELP/);
  });

  it("keeps registries independent, so one test cannot pollute another", async () => {
    const a = new Metrics();
    const b = new Metrics();
    a.operations.inc({ operation: "InboxOverview", outcome: "ok" });
    expect(await b.render()).not.toContain('operation="InboxOverview"');
  });
});

describe("upstream instrumentation", () => {
  const upstreamWith = (fetchImpl: typeof fetch, metrics: Metrics) =>
    new Upstream(testConfig({ breakerThreshold: 1 }), { fetchImpl, metrics });

  it("counts a successful call and times it", async () => {
    const metrics = new Metrics();
    const fetchImpl = (async () => jsonResponse({})) as typeof fetch;
    await upstreamWith(fetchImpl, metrics).get("auth-svc", "http://a", "/x", CALLER);

    const text = await metrics.render();
    expect(text).toContain('graphql_upstream_calls_total{service="auth-svc",outcome="ok"} 1');
    expect(text).toContain("graphql_upstream_duration_seconds");
  });

  it("labels an upstream status separately from a transport failure", async () => {
    const metrics = new Metrics();
    const fetchImpl = (async () => jsonResponse({}, 503)) as typeof fetch;
    await upstreamWith(fetchImpl, metrics)
      .get("auth-svc", "http://a", "/x", CALLER)
      .catch(() => {});

    expect(await metrics.render()).toContain('outcome="http_503"');
  });

  it("raises the breaker gauge once the breaker opens", async () => {
    const metrics = new Metrics();
    const fetchImpl = (async () => jsonResponse({}, 500)) as typeof fetch;
    const upstream = upstreamWith(fetchImpl, metrics);

    await upstream.get("auth-svc", "http://a", "/x", CALLER).catch(() => {});
    await upstream.get("auth-svc", "http://a", "/x", CALLER).catch(() => {});

    expect(await metrics.render()).toContain('graphql_upstream_breaker_open{service="auth-svc"} 1');
  });

  it("clears the gauge again once the service recovers", async () => {
    const metrics = new Metrics();
    let failing = true;
    const fetchImpl = (async () => (failing ? jsonResponse({}, 500) : jsonResponse({}))) as typeof fetch;
    const upstream = new Upstream(testConfig({ breakerThreshold: 1, breakerResetMs: 0 }), {
      fetchImpl,
      metrics,
    });

    await upstream.get("auth-svc", "http://a", "/x", CALLER).catch(() => {});
    failing = false;
    await upstream.get("auth-svc", "http://a", "/x", CALLER).catch(() => {});

    expect(await metrics.render()).toContain('graphql_upstream_breaker_open{service="auth-svc"} 0');
  });
});

describe("loader batch size", () => {
  it("records the batch, which is the signal that batching still works", async () => {
    const metrics = new Metrics();
    const cfg = testConfig();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const ids = new URL(String(url)).searchParams.get("ids")!.split(",");
      return jsonResponse(ids.map((id, i) => userRow(id, `U${i}`)));
    }) as unknown as typeof fetch;

    const loaders = createLoaders(cfg, new Upstream(cfg, { fetchImpl }), CALLER, metrics);
    await Promise.all([1, 2, 3, 4].map((n) => loaders.usersById.load(U(n))));

    const text = await metrics.render();
    // Four keys, one batch: the bucket at 5 must have caught it and the
    // bucket at 1 must not.
    expect(text).toContain('graphql_loader_batch_size_sum{loader="usersById"} 4');
    expect(text).toContain('graphql_loader_batch_size_count{loader="usersById"} 1');
  });
});
