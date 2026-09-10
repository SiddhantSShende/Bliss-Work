/**
 * OpenTelemetry tracing — gated on OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * Deliberately the same contract as `services/auth-svc/app/tracing.py`: unset or
 * empty means no provider, no exporter, no spans and no startup change, so a dev
 * run with no collector stays clean. Set (e.g. `http://otel-collector:4317`) and
 * spans export over OTLP gRPC through a batch processor, so an unreachable
 * collector never blocks or crashes the process.
 *
 * Why this matters more here than elsewhere: the gateway sits BETWEEN the
 * browser and every service it composes. Without it the platform's traces stop
 * at the edge and resume, unlinked, inside each service — the exact failure the
 * gateway was warned against. HTTP instrumentation both continues the inbound
 * trace and injects `traceparent` into the upstream calls, so one browser
 * request is one connected trace across three processes.
 */
import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import type { Logger } from "./logging.js";

export const SERVICE_NAME = "graph-gw";

export interface Tracing {
  shutdown(): Promise<void>;
}

const DISABLED: Tracing = { shutdown: async () => {} };

/**
 * Start tracing if configured. Returns a handle whose `shutdown` flushes
 * buffered spans; when disabled it is a no-op, so callers need no branch.
 *
 * Imports are dynamic so a deployment with tracing off never loads the SDK.
 */
export async function startTracing(
  env: NodeJS.ProcessEnv,
  log: Logger,
): Promise<Tracing> {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) {
    log.info("tracing_disabled", { reason: "OTEL_EXPORTER_OTLP_ENDPOINT unset" });
    return DISABLED;
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, resources, semconv] =
      await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/exporter-trace-otlp-grpc"),
        import("@opentelemetry/instrumentation-http"),
        import("@opentelemetry/resources"),
        import("@opentelemetry/semantic-conventions"),
      ]);

    // Route the SDK's own diagnostics into our structured log rather than
    // letting it write unstructured lines to stderr.
    diag.setLogger(otelDiagLogger(log), DiagLogLevel.ERROR);

    const sdk = new NodeSDK({
      resource: resources.resourceFromAttributes({
        [semconv.SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME,
        [semconv.SEMRESATTRS_SERVICE_VERSION]: env.IMAGE_TAG ?? "dev",
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        new HttpInstrumentation({
          // The probes are the highest-frequency requests this process serves and
          // say nothing about a user's journey. Tracing them buries the traces
          // that matter under kubelet noise.
          ignoreIncomingRequestHook: (req) =>
            req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics",
        }),
      ],
    });

    sdk.start();
    log.info("tracing_enabled", { endpoint });
    return {
      shutdown: () =>
        sdk.shutdown().catch((err: unknown) => {
          log.warn("tracing_shutdown_failed", { error: String(err) });
        }),
    };
  } catch (err) {
    // Tracing is observability, not function. A broken exporter config must not
    // take the gateway down with it.
    log.error("tracing_start_failed", { error: String(err) });
    return DISABLED;
  }
}

function otelDiagLogger(log: Logger): DiagLogger {
  return {
    error: (msg, ...args) => log.warn("otel_error", { message: msg, args: args.map(String) }),
    warn: (msg) => log.warn("otel_warn", { message: msg }),
    info: () => {},
    debug: () => {},
    verbose: () => {},
  };
}
