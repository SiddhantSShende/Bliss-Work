import assert from "node:assert/strict";
import { test } from "node:test";
import { routeMetricPath } from "../src/routeLabels.ts";

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
