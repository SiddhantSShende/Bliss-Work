/**
 * The gateway's only way to reach a backing service: an HTTP GET with a
 * deadline, a circuit breaker, and the caller's identity forwarded verbatim.
 *
 * ── Tracing ─────────────────────────────────────────────────────────────────
 * Each call runs inside its own span and injects the CURRENT trace context into
 * the outgoing headers. Both matter, and neither is automatic here: the
 * platform's HTTP instrumentation patches `node:http`, and this client uses
 * `fetch`, so without this the gateway emits one span for the inbound request
 * and nothing for the three calls it fans out — the traces stop at exactly the
 * hop the gateway was added at.
 *
 * The propagator is a no-op when no SDK is registered, so with tracing off this
 * costs nothing and the inbound `traceparent` forwarded below still stands.
 * When tracing is on, injection overwrites it with a context whose parent is
 * THIS span, which is what links the three services into one trace rather than
 * three siblings.
 *
 * ── The rule this file enforces ─────────────────────────────────────────────
 * The gateway has NO credential of its own. Every upstream call carries the
 * end user's `Authorization` header exactly as it arrived, because each service
 * derives `orgId`/`userId` from the verified JWT and applies row-level security
 * from it. A service account here would silently defeat every tenant boundary
 * in the platform, so there is deliberately no way to make a call without a
 * caller token.
 */
import { httpStatusToCode, type ApiErrorBody, type ErrorCode } from "@taskboard/shared";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { GraphQLError } from "graphql";
import type { GatewayConfig } from "./config.js";
import type { Logger } from "./logging.js";
import type { Metrics } from "./metrics.js";

/** Headers propagated from the inbound request to every upstream call.
 *  Trace continuity is not decoration: OTEL is wired across the services, and a
 *  gateway that starts a fresh trace is where distributed traces go to die. */
export const FORWARDED_HEADERS = ["traceparent", "tracestate", "x-request-id"] as const;

export interface CallerContext {
  /** The raw `Authorization` header value, e.g. "Bearer eyJ…". */
  readonly authorization: string;
  readonly forwarded: Readonly<Record<string, string>>;
}

/** Surfaced to the client as a GraphQL error carrying the platform's own
 *  `ErrorCode`, so the UI keeps switching on the vocabulary it already knows. */
export function upstreamError(code: ErrorCode, message: string, service: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code, service } });
}

/**
 * Per-service circuit breaker.
 *
 * Opens after `threshold` CONSECUTIVE failures and stays open for `resetMs`,
 * then lets exactly one probe through. The gateway is a hard dependency for
 * every screen that moves onto it, so an upstream that is down must fail fast
 * and let the query return a partial result — a screen missing one panel beats
 * a screen that hangs until the client's own 30s timeout.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the call must be refused without touching the network. */
  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (this.now() - this.openedAt < this.resetMs) return true;
    // Half-open: admit a single probe, keep refusing everything else until it
    // reports back. Without this an idle-then-recovering service is hit by the
    // full stampede the instant the window elapses.
    if (this.probing) return true;
    this.probing = true;
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probing = false;
  }

  recordFailure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export interface UpstreamOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Optional so unit tests can construct an Upstream without a registry.
   *  Production always supplies both — see `createGateway`. */
  readonly metrics?: Metrics;
  readonly log?: Logger;
}

export class Upstream {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly opts: UpstreamOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private breakerFor(service: string): CircuitBreaker {
    let b = this.breakers.get(service);
    if (!b) {
      b = new CircuitBreaker(this.cfg.breakerThreshold, this.cfg.breakerResetMs, this.opts.now);
      this.breakers.set(service, b);
    }
    return b;
  }

  /**
   * GET `base + path` as the caller. Throws a `GraphQLError` on any failure —
   * never returns a partial or defaulted body, because a resolver silently
   * yielding `null` for "the service was down" is indistinguishable from
   * "the record does not exist".
   */
  get<T>(service: string, base: string, path: string, caller: CallerContext): Promise<T> {
    return tracer.startActiveSpan(
      `GET ${service}`,
      { attributes: { "peer.service": service, "http.method": "GET", "http.route": path } },
      async (span) => {
        try {
          const body = await this.request<T>(service, base, path, caller);
          span.setStatus({ code: SpanStatusCode.OK });
          return body;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async request<T>(
    service: string,
    base: string,
    path: string,
    caller: CallerContext,
  ): Promise<T> {
    const breaker = this.breakerFor(service);
    if (breaker.isOpen()) {
      this.opts.metrics?.breakerOpen.set({ service }, 1);
      this.opts.metrics?.upstreamCalls.inc({ service, outcome: "breaker_open" });
      this.opts.log?.warn("upstream_refused", { service, reason: "breaker_open" });
      throw upstreamError("service_unavailable", `${service} is unavailable`, service);
    }
    this.opts.metrics?.breakerOpen.set({ service }, 0);
    const stopTimer = this.opts.metrics?.upstreamDuration.startTimer({ service });

    // A stalled connection must not pin the resolver — and with it the whole
    // query — open until the client gives up. The deadline has to cover the
    // BODY read too, not just headers: fetch() resolves as soon as headers
    // arrive, so a timer cleared right after it would let a backend that
    // stalls or trickles the body hang the resolver indefinitely. It stays
    // armed until every body-reading branch below (success, non-ok error
    // envelope, malformed JSON) has finished.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.upstreamTimeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${base}${path}`, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: caller.authorization,
            // The inbound trace headers and x-request-id, then the live trace
            // context on top — see the tracing note at the top of this file.
            ...caller.forwarded,
            ...traceHeaders(),
          },
          signal: controller.signal,
        });
      } catch (cause) {
        breaker.recordFailure();
        stopTimer?.();
        const timedOut = controller.signal.aborted;
        this.opts.metrics?.upstreamCalls.inc({
          service,
          outcome: timedOut ? "timeout" : "unreachable",
        });
        this.opts.log?.warn("upstream_failed", {
          service,
          path,
          reason: timedOut ? "timeout" : "unreachable",
          error: String(cause),
        });
        throw upstreamError(
          timedOut ? "gateway_timeout" : "service_unavailable",
          timedOut ? `${service} timed out` : `${service} is unreachable`,
          service,
        );
      }

      if (!res.ok) {
        // 4xx is the caller's fault and says nothing about the service's health,
        // so it must not push the breaker toward open. Only 5xx counts.
        if (res.status >= 500) breaker.recordFailure();
        else breaker.recordSuccess();
        stopTimer?.();
        this.opts.metrics?.upstreamCalls.inc({ service, outcome: `http_${res.status}` });
        this.opts.log?.warn("upstream_status", { service, path, status: res.status });
        throw upstreamError(httpStatusToCode(res.status), await errorMessage(res, service), service);
      }

      breaker.recordSuccess();
      try {
        const body = (await res.json()) as T;
        stopTimer?.();
        this.opts.metrics?.upstreamCalls.inc({ service, outcome: "ok" });
        return body;
      } catch (cause) {
        // The deadline can also fire while the body is still streaming in —
        // aborting a Response mid-read rejects res.json() the same way an
        // aborted fetch() rejects above, so it gets the same classification.
        const timedOut = controller.signal.aborted;
        breaker.recordFailure();
        stopTimer?.();
        this.opts.metrics?.upstreamCalls.inc({ service, outcome: timedOut ? "timeout" : "malformed" });
        if (timedOut) {
          this.opts.log?.warn("upstream_failed", { service, path, reason: "timeout", error: String(cause) });
          throw upstreamError("gateway_timeout", `${service} timed out`, service);
        }
        this.opts.log?.error("upstream_malformed_json", { service, path });
        throw upstreamError("internal_error", `${service} returned malformed JSON`, service);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

const tracer = trace.getTracer("graph-gw");

/** W3C trace context for the ACTIVE span, as headers. Empty when no SDK is
 *  registered, which is how tracing stays a deployment choice rather than a
 *  code path. */
function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Reuse the upstream's own envelope message when it sent one; otherwise say
 *  something generic. Never echo an arbitrary response body — it may carry
 *  internal detail the end user should not see. */
async function errorMessage(res: Response, service: string): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    const message = body?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Not the platform envelope — fall through to the generic message.
  }
  return `${service} responded ${res.status}`;
}
