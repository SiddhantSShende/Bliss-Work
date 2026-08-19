/**
 * Prometheus metrics.
 *
 * Names match what the rest of the platform already exposes — `http_requests_total`
 * and `http_request_duration_seconds` with the same default buckets — so a
 * dashboard or alert rule written against the Go services works here unchanged.
 *
 * The gateway-specific series answer the questions only a gateway raises:
 * how many upstream calls did one client request cost (the whole N+1 argument),
 * and is a breaker open right now.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** The platform's Go services use prometheus.DefBuckets; matching them keeps
 *  histogram_quantile() comparable across services on one dashboard. */
const DEF_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  readonly registry = new Registry();

  readonly httpRequests: Counter<"method" | "path" | "status">;
  readonly httpDuration: Histogram<"method" | "path">;
  readonly operations: Counter<"operation" | "outcome">;
  readonly upstreamCalls: Counter<"service" | "outcome">;
  readonly upstreamDuration: Histogram<"service">;
  readonly breakerOpen: Gauge<"service">;
  readonly loaderBatch: Histogram<"loader">;

  constructor() {
    // Event-loop lag, GC, heap, fds. On a service whose whole job is fanning out
    // I/O, loop lag is the first thing that moves when it is in trouble.
    collectDefaultMetrics({ register: this.registry, prefix: "graph_gw_" });

    this.httpRequests = new Counter({
      name: "http_requests_total",
      help: "HTTP requests handled by the gateway",
      labelNames: ["method", "path", "status"] as const,
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency",
      labelNames: ["method", "path"] as const,
      buckets: DEF_BUCKETS,
      registers: [this.registry],
    });

    this.operations = new Counter({
      name: "graphql_operations_total",
      help: "GraphQL operations executed, by name and outcome",
      // `operation` is the REGISTERED name, never client-supplied text — an
      // unknown operation is rejected before it reaches here, so this label
      // cannot be used to explode cardinality.
      labelNames: ["operation", "outcome"] as const,
      registers: [this.registry],
    });

    this.upstreamCalls = new Counter({
      name: "graphql_upstream_calls_total",
      help: "REST calls made to backing services",
      labelNames: ["service", "outcome"] as const,
      registers: [this.registry],
    });

    this.upstreamDuration = new Histogram({
      name: "graphql_upstream_duration_seconds",
      help: "Latency of calls to backing services",
      labelNames: ["service"] as const,
      buckets: DEF_BUCKETS,
      registers: [this.registry],
    });

    this.breakerOpen = new Gauge({
      name: "graphql_upstream_breaker_open",
      help: "1 while a service's circuit breaker is open",
      labelNames: ["service"] as const,
      registers: [this.registry],
    });

    // The series that proves the gateway is doing its job. If p99 batch size
    // stays at 1 while rows-per-page grows, batching has silently regressed and
    // the gateway has become an N+1 generator.
    this.loaderBatch = new Histogram({
      name: "graphql_loader_batch_size",
      help: "Keys per DataLoader batch",
      labelNames: ["loader"] as const,
      buckets: [1, 2, 5, 10, 25, 50, 100, 200],
      registers: [this.registry],
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
