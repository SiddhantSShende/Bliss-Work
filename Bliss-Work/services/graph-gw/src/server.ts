/**
 * Yoga wiring. Kept separate from `index.ts` so tests can drive the gateway
 * through `yoga.fetch(...)` — a real request, real plugins, real validation —
 * without binding a port.
 */
import { createYoga, type Plugin } from "graphql-yoga";
import { NoSchemaIntrospectionCustomRule, type ValidationRule } from "graphql";
import type { GatewayConfig } from "./config.js";
import { createContext } from "./context.js";
import { createDepthLimitRule } from "./depthLimit.js";
import { createLogger, type Logger } from "./logging.js";
import { Metrics } from "./metrics.js";
import { usePersistedOperations } from "./persisted.js";
import { schema } from "./schema.js";
import { Upstream, type UpstreamOptions } from "./upstream.js";

export const GRAPHQL_ENDPOINT = "/graphql";

/** envelop's hook for contributing validation rules; graphql-yoga does not
 *  re-export a helper for it, and the hook is two lines. */
function useValidationRules(rules: readonly ValidationRule[]): Plugin {
  return {
    onValidate({ addValidationRule }) {
      for (const rule of rules) addValidationRule(rule);
    },
  };
}

/** Counts executed operations by name and outcome. The name is the REGISTERED
 *  one — an unknown operation is rejected before execution — so this label
 *  cannot be driven to unbounded cardinality by a client. */
function useOperationMetrics(metrics: Metrics): Plugin {
  return {
    onExecute({ args }) {
      const operation = args.operationName ?? "anonymous";
      return {
        onExecuteDone({ result }) {
          const errors = (result as { errors?: readonly unknown[] })?.errors;
          metrics.operations.inc({
            operation,
            // "partial" is its own outcome, not a failure: data AND errors is
            // the degradation the gateway is designed to produce, and folding
            // it into "error" would make every upstream blip look like an
            // outage on the dashboard.
            outcome: !errors?.length
              ? "ok"
              : (result as { data?: unknown })?.data
                ? "partial"
                : "error",
          });
        },
      };
    },
  };
}

export interface GatewayDeps {
  readonly log?: Logger;
  readonly metrics?: Metrics;
}

export function createGateway(
  cfg: GatewayConfig,
  upstreamOpts: UpstreamOptions = {},
  deps: GatewayDeps = {},
) {
  const log = deps.log ?? createLogger(cfg.logLevel);
  const metrics = deps.metrics ?? new Metrics();
  const upstream = new Upstream(cfg, { ...upstreamOpts, metrics, log });

  const rules: ValidationRule[] = [createDepthLimitRule(cfg.maxQueryDepth)];
  // Introspection is a map of the product's data access. Off unless explicitly
  // enabled, and `loadConfig` refuses to enable it in production at all.
  if (!cfg.introspection) rules.push(NoSchemaIntrospectionCustomRule);

  const yoga = createYoga({
    schema,
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    // Yoga serves query operations over GET out of the box, which is what makes
    // a persisted operation cacheable by URL — without it the trusted-documents
    // argument collapses back to uncacheable POSTs. It refuses mutations over
    // GET, which is right: this schema has none, and a mutation behind a
    // cacheable URL is a bug waiting to happen.
    landingPage: false,
    graphiql: cfg.introspection,
    // Unexpected errors (a Zod parse failure, a bug) are replaced with a generic
    // message in production. Deliberate GraphQLErrors — the upstream envelope,
    // auth refusals — carry their own code and pass through.
    maskedErrors: cfg.isProduction,
    context: ({ request }) => createContext(cfg, upstream, request.headers, { log, metrics }),
    plugins: [
      usePersistedOperations({ allowArbitrary: cfg.allowArbitraryQueries }),
      useValidationRules(rules),
      useOperationMetrics(metrics),
    ],
    // The browser reaches this through Caddy on the same origin as /api/*, so
    // credentials never ride a cross-origin request here; the bearer token is
    // set explicitly by the client on every call.
    cors: false,
  });

  return { yoga, upstream, metrics, log };
}
