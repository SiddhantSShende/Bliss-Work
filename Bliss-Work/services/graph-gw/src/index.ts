/**
 * graph-gw entrypoint.
 *
 * Read-composition GraphQL gateway in front of the REST services. It owns no
 * database and no credential of its own: every field resolves through a backing
 * service's HTTP API, carrying the end user's token.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { Metrics } from "./metrics.js";
import { routeMetricPath } from "./routeLabels.js";
import { startTracing } from "./tracing.js";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);
const metrics = new Metrics();

// ── Tracing starts BEFORE node:http is pulled in ────────────────────────────
// instrumentation-http patches the module as it is required, so anything that
// imports http first is invisible to it. That is why the server and the http
// module below are dynamic imports rather than top-level ones — a static import
// would be hoisted above this line and silently produce a gateway that emits no
// spans while looking correctly configured.
const tracing = await startTracing(process.env, log);
const { createServer } = await import("node:http");
const { createGateway, GRAPHQL_ENDPOINT } = await import("./server.js");

const { yoga } = createGateway(cfg, {}, { log, metrics });

/** Flipped by SIGTERM. Readiness fails from that moment, so the load balancer
 *  takes this replica out of rotation BEFORE the socket stops accepting — the
 *  ordering that makes a rolling deploy lose no requests. */
let draining = false;
let inFlight = 0;

const server = createServer((req, res) => {
  const path = routeMetricPath(req.url ?? "/");

  if (path === "/healthz") return respond(res, 200, { status: "ok" });
  if (path === "/readyz") {
    return draining
      ? respond(res, 503, { status: "draining" })
      : respond(res, 200, { status: "ok" });
  }
  if (path === "/metrics") {
    void metrics
      .render()
      .then((body) => {
        res.writeHead(200, { "content-type": metrics.contentType });
        res.end(body);
      })
      .catch(() => respond(res, 500, { status: "error" }));
    return;
  }

  inFlight += 1;
  const stopTimer = metrics.httpDuration.startTimer({ method: req.method ?? "GET", path });
  res.on("close", () => {
    inFlight -= 1;
    stopTimer();
    metrics.httpRequests.inc({
      method: req.method ?? "GET",
      path,
      status: String(res.statusCode),
    });
  });

  void yoga(req, res);
});

function respond(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

server.listen(cfg.port, "0.0.0.0", () => {
  log.info("graph_gw_ready", {
    port: cfg.port,
    endpoint: GRAPHQL_ENDPOINT,
    arbitrary_queries: cfg.allowArbitraryQueries,
    introspection: cfg.introspection,
  });
});

// ── Shutdown ────────────────────────────────────────────────────────────────
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // a second signal must not race the first
    shuttingDown = true;
    draining = true;
    log.info("graph_gw_draining", { signal, in_flight: inFlight, grace_ms: cfg.shutdownGraceMs });

    // Stop accepting, then let in-flight work finish. Idle keep-alive sockets
    // are closed explicitly — without this, close() waits on connections that
    // are holding no request at all and the grace timer always expires.
    server.close(() => finish(0));
    server.closeIdleConnections();

    setTimeout(() => {
      log.warn("graph_gw_drain_timeout", { in_flight: inFlight });
      finish(1);
    }, cfg.shutdownGraceMs).unref();
  });
}

function finish(code: number): void {
  void tracing.shutdown().finally(() => {
    log.info("graph_gw_stopped", { code });
    process.exit(code);
  });
}
