import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAdminRoute, routeMetricPath } from "../src/routeLabels.ts";

test("keeps the registered GraphQL route as a useful metric label", () => {
  assert.equal(routeMetricPath("/graphql"), "/graphql");
  assert.equal(routeMetricPath("/graphql?operationName=GetInbox"), "/graphql");
});

test("collapses unknown and scanner-controlled paths to a bounded label", () => {
  const paths = [
    "/",
    "/graphql/not-a-route",
    "/.env",
    "/wp-admin/../../etc/passwd",
    `/scan/${"a".repeat(10_000)}`,
  ];
  const labels = new Set(paths.map(routeMetricPath));

  assert.deepEqual([...labels], ["other"]);
});

// Regression coverage for a P0: index.ts used to dispatch admin requests on
// routeMetricPath()'s result, which collapses /healthz, /readyz and /metrics
// to the same bounded "other" label as everything else — so none of those
// three `=== "/healthz"` etc. comparisons could ever be true, and every
// request to them silently fell through to the GraphQL handler instead
// (breaking Docker health/readiness checks and Prometheus scraping in prod).
test("matches each of the three admin routes, query string and all", () => {
  assert.equal(matchAdminRoute("/healthz"), "/healthz");
  assert.equal(matchAdminRoute("/readyz"), "/readyz");
  assert.equal(matchAdminRoute("/metrics"), "/metrics");
  assert.equal(matchAdminRoute("/healthz?probe=1"), "/healthz");
});

test("does not match GraphQL or unknown/invalid paths", () => {
  const paths = [
    "/graphql",
    "/graphql?operationName=GetInbox",
    "/",
    "/graphql/not-a-route",
    "/.env",
    "/wp-admin/../../etc/passwd",
    `/scan/${"a".repeat(10_000)}`,
  ];

  for (const path of paths) {
    assert.equal(matchAdminRoute(path), null, `expected ${path} to not be an admin route`);
  }
});

test("admin routes and the bounded metric label never agree on a path", () => {
  // The bug this guards against: reusing routeMetricPath() for dispatch. If
  // these two ever again describe the same set of paths, the dispatch bug is
  // back.
  for (const path of ["/healthz", "/readyz", "/metrics"]) {
    assert.equal(routeMetricPath(path), "other");
    assert.notEqual(matchAdminRoute(path), null);
  }
});
