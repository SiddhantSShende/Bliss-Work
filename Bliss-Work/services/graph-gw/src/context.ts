/**
 * Per-request context: who is calling, and the loaders scoped to them.
 *
 * The gateway never mints, rewrites or substitutes credentials. It reads the
 * inbound `Authorization` header and passes that exact value upstream, so every
 * service keeps deriving `orgId`/`userId` from the JWT it verifies itself. A
 * request without one is refused HERE, before any resolver runs, so there is no
 * code path in which a resolver executes with no caller.
 */
import { GraphQLError } from "graphql";
import type { GatewayConfig } from "./config.js";
import { createLoaders, type Loaders } from "./loaders.js";
import type { Logger } from "./logging.js";
import type { Metrics } from "./metrics.js";
import { FORWARDED_HEADERS, type CallerContext, type Upstream } from "./upstream.js";

export interface GraphContext {
  readonly cfg: GatewayConfig;
  readonly upstream: Upstream;
  readonly caller: CallerContext;
  readonly loaders: Loaders;
  /** Stamped with this request's `request_id`, so every line logged while
   *  resolving correlates with the upstream calls it made. */
  readonly log: Logger;
}

export function unauthorized(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: "unauthorized", http: { status: 401 } },
  });
}

/**
 * Build the caller identity from request headers.
 *
 * The token is NOT verified here. auth-svc is the sole issuer and every service
 * verifies via cached JWKS; a second verification in the gateway would be a
 * second place to get key rotation wrong, and it would not make the upstream
 * checks redundant — they still run. What the gateway enforces is only that a
 * bearer credential is present, which is what lets it reject junk without
 * spending an upstream call on it.
 */
export function callerFromHeaders(headers: Headers): CallerContext {
  const authorization = headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw unauthorized("a bearer token is required");
  }

  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value) forwarded[name] = value;
  }

  return { authorization, forwarded: Object.freeze(forwarded) };
}

/** Called once per request by Yoga. Never memoize the result: the loaders it
 *  builds cache by user id with no tenant in the key (see `loaders.ts`). */
export function createContext(
  cfg: GatewayConfig,
  upstream: Upstream,
  headers: Headers,
  deps: { log: Logger; metrics?: Metrics },
): GraphContext {
  const caller = callerFromHeaders(headers);
  const log = deps.log.with({ request_id: headers.get("x-request-id") ?? undefined });
  return {
    cfg,
    upstream,
    caller,
    log,
    loaders: createLoaders(cfg, upstream, caller, deps.metrics),
  };
}
