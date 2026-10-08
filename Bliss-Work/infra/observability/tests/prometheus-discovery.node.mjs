import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const prometheus = readFileSync(resolve(root, "infra/observability/prometheus.yml"), "utf8");
const compose = readFileSync(resolve(root, "docker-compose.prod.yml"), "utf8");

function blockFor(source, header, nextHeader) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const suffix = source.slice(start + header.length);
  const end =
    typeof nextHeader === "string"
      ? source.indexOf(nextHeader, start + header.length)
      : nextHeader.exec(suffix)?.index + start + header.length;
  return source.slice(start, end === -1 ? undefined : end);
}

test("replicated Prometheus targets use per-address DNS discovery and identity", () => {
  const targets = [
    ["auth-svc", 8001],
    ["task-svc", 8002],
    ["notification-svc", 8003],
    ["messaging-svc", 8004],
    ["graph-gw", 8007],
    ["integrations-svc", 8005],
    ["telemetry-svc", 8006],
  ];

  for (const [service, port] of targets) {
    const job = blockFor(
      prometheus,
      `  - job_name: ${service}\n`,
      "\n  - job_name:",
    );
    const serviceConfig = blockFor(
      compose,
      `  ${service}:\n`,
      /\n  [a-zA-Z0-9_-]+:\n/,
    );

    assert.match(serviceConfig, /^\s+replicas: 2$/m, `${service} must remain replicated`);
    assert.match(job, new RegExp(`names: \\["${service}"\\]`));
    assert.match(job, /type: A/);
    assert.match(job, new RegExp(`port: ${port}\\b`));
    assert.doesNotMatch(job, /static_configs:/);
    assert.match(job, /source_labels: \[__address__\]\s+target_label: instance/);
  }
});
