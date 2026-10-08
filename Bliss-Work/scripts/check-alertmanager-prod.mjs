#!/usr/bin/env node
/**
 * Guard production Alertmanager against going back to the dev sink.
 *
 * alertmanager.yml (dev) routes every alert to an otel-collector URL that 404s;
 * docker-compose.prod.yml once mounted that same file, so no prod alert was ever
 * delivered. This asserts the prod service mounts the prod config, that config
 * delivers via a secret file (not a baked-in URL), and that the compose mount
 * of that secret is fail-closed. Reads files only.
 *
 * Usage:  node scripts/check-alertmanager-prod.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const problems = [];

const compose = read("docker-compose.prod.yml");
const svc = /^ {2}alertmanager:\n([\s\S]*?)(?=^ {2}\S)/m.exec(compose)?.[1] ?? "";
if (!svc) problems.push("docker-compose.prod.yml: no alertmanager service found");
if (!/alertmanager\/alertmanager\.prod\.yml:\/etc\/alertmanager\/alertmanager\.yml/.test(svc)) {
  problems.push("docker-compose.prod.yml: alertmanager must mount alertmanager.prod.yml (not the dev alertmanager.yml)");
}
if (/observability\/alertmanager\/alertmanager\.yml:/.test(svc)) {
  problems.push("docker-compose.prod.yml: alertmanager still mounts the dev alertmanager.yml");
}
if (!/\$\{ALERTMANAGER_WEBHOOK_URL_FILE:\?/.test(svc)) {
  problems.push("docker-compose.prod.yml: the webhook secret source must use ${ALERTMANAGER_WEBHOOK_URL_FILE:?...} so prod fails closed when unset");
}
if (!/create_host_path:\s*false/.test(svc)) {
  problems.push("docker-compose.prod.yml: the webhook secret mount needs create_host_path: false (else docker creates an empty directory and alerts are dropped)");
}

const prod = read("infra/observability/alertmanager/alertmanager.prod.yml");
if (/dev-sink|otel-collector/.test(prod)) problems.push("alertmanager.prod.yml: references the dev sink");
if (!/url_file:\s*\/etc\/alertmanager\/secrets\/webhook_url/.test(prod)) {
  problems.push("alertmanager.prod.yml: the receiver must read its URL from url_file");
}
if (/^\s*-?\s*url:\s*\S/m.test(prod)) problems.push("alertmanager.prod.yml: a literal webhook url: must not be committed (use url_file)");

if (!/^ALERTMANAGER_WEBHOOK_URL_FILE=/m.test(read(".env.prod.example"))) {
  problems.push(".env.prod.example: ALERTMANAGER_WEBHOOK_URL_FILE is not documented");
}

if (problems.length) {
  console.error("check-alertmanager-prod: " + problems.length + " problem(s)\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("check-alertmanager-prod: OK");
