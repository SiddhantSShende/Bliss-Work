import { parseLevel, type LogLevel } from "./logging.js";

/**
 * Gateway configuration, resolved once at boot and FAIL-CLOSED.
 *
 * The two settings that matter for safety (`allowArbitraryQueries` and
 * `introspection`) default to off and REFUSE to be turned on in production. A
 * gateway that silently accepts arbitrary documents is a different, much larger
 * attack surface than the one this service was reviewed as, and the usual way
 * that happens is a debugging session that outlives its deploy.
 */

export interface GatewayConfig {
  readonly port: number;
  readonly authBase: string;
  readonly messagingBase: string;
  /** Abort an upstream call after this long. MUST stay below the browser
   *  client's own 30s timeout so the gateway fails first and can answer with a
   *  partial result rather than having the client give up on the whole query. */
  readonly upstreamTimeoutMs: number;
  /** Consecutive upstream failures before the breaker opens for that service. */
  readonly breakerThreshold: number;
  /** How long the breaker stays open before letting one probe through. */
  readonly breakerResetMs: number;
  /** Rejects documents nested deeper than this. Belt-and-braces behind the
   *  operation allow-list — it is what still holds if arbitrary queries are
   *  ever enabled in a non-production environment. */
  readonly maxQueryDepth: number;
  /** Dev/test escape hatch: execute documents that are not in the registry. */
  readonly allowArbitraryQueries: boolean;
  readonly introspection: boolean;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  /** How long to let in-flight requests finish on SIGTERM before forcing exit.
   *  Must exceed `upstreamTimeoutMs` or a rolling deploy cuts requests that
   *  were still waiting on a legitimately slow upstream. */
  readonly shutdownGraceMs: number;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const value = env[key] ?? fallback;
  if (!value) throw new ConfigError(`${key} is required`);
  return value.replace(/\/+$/, "");
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Only the exact string "true" enables a flag — "false", "0" and typos all
 *  read as off, so a misspelled value fails safe instead of opening the gate. */
function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const isProduction = env.NODE_ENV === "production";

  const allowArbitraryQueries = flag(env, "GRAPHQL_ALLOW_ARBITRARY_QUERIES");
  const introspection = flag(env, "GRAPHQL_INTROSPECTION");

  // Refuse to boot rather than serve a production gateway with the guards off.
  // Crashing here is loud and recoverable; booting is neither.
  if (isProduction && allowArbitraryQueries) {
    throw new ConfigError(
      "GRAPHQL_ALLOW_ARBITRARY_QUERIES cannot be enabled when NODE_ENV=production — " +
        "production executes only the operations in the shared registry",
    );
  }
  if (isProduction && introspection) {
    throw new ConfigError(
      "GRAPHQL_INTROSPECTION cannot be enabled when NODE_ENV=production",
    );
  }

  return {
    port: positiveInt(env, "PORT", 8007),
    // Service-to-service, so these are the in-network addresses, NOT the public
    // /api/* paths the browser uses. The gateway is inside the mesh with them.
    authBase: required(env, "AUTH_BASE", isProduction ? undefined : "http://localhost:8001"),
    messagingBase: required(
      env,
      "MESSAGING_BASE",
      isProduction ? undefined : "http://localhost:8004",
    ),
    upstreamTimeoutMs: positiveInt(env, "UPSTREAM_TIMEOUT_MS", 5_000),
    breakerThreshold: positiveInt(env, "BREAKER_THRESHOLD", 5),
    breakerResetMs: positiveInt(env, "BREAKER_RESET_MS", 10_000),
    maxQueryDepth: positiveInt(env, "GRAPHQL_MAX_DEPTH", 10),
    allowArbitraryQueries,
    introspection,
    isProduction,
    logLevel: parseLevel(env.LOG_LEVEL),
    shutdownGraceMs: positiveInt(env, "SHUTDOWN_GRACE_MS", 15_000),
  };
}
