import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const compose = readFileSync(resolve(root, "docker-compose.prod.yml"), "utf8");
const graphGateway = compose.slice(
  compose.indexOf("  graph-gw:\n"),
  compose.indexOf("\n  otel-collector:", compose.indexOf("  graph-gw:\n")),
);

test("production graph-gw stop grace exceeds its 15-second application drain", () => {
  assert.match(graphGateway, /^\s+stop_grace_period: 20s$/m);
});
