/**
 * Trusted documents: the gateway executes operations from the shared registry
 * and, in production, nothing else.
 *
 * Clients send the operation NAME and variables — `GET /graphql?operationName=
 * InboxOverview&variables={…}` — and the gateway substitutes the document text.
 * Three things follow from that, and all three are the point:
 *
 *   1. The request body shrinks to a name, so the document is not on the wire.
 *   2. It is a GET with a stable URL, so browsers and CDNs can cache it. A
 *      POST-only /graphql throws away the HTTP caching the REST endpoints
 *      behind Caddy already get, which would make this gateway a downgrade.
 *   3. Only allow-listed operations run, which removes query-depth and
 *      query-injection abuse as a class rather than mitigating it.
 */
import { GRAPHQL_OPERATIONS, isGraphqlOperationName } from "@taskboard/shared";
import { GraphQLError } from "graphql";

export interface OperationParams {
  query?: string;
  operationName?: string;
  variables?: unknown;
  extensions?: unknown;
}

export function badRequest(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: "bad_request", http: { status: 400 } },
  });
}

/**
 * Turn inbound params into params carrying a document, or throw.
 *
 * With `allowArbitrary` off — the only configuration production can boot in —
 * an inline `query` is REFUSED rather than ignored. Silently dropping it would
 * let a caller believe their document ran when a different one did.
 */
export function resolvePersistedParams(
  params: OperationParams,
  opts: { allowArbitrary: boolean },
): OperationParams {
  const name = params.operationName;

  if (typeof params.query === "string" && params.query.trim() !== "") {
    if (opts.allowArbitrary) return params;
    throw badRequest(
      "this gateway executes only registered operations; send operationName without query",
    );
  }

  if (!name) {
    throw badRequest("operationName is required");
  }
  if (!isGraphqlOperationName(name)) {
    // Deliberately does not list the registry — that is a map of the product's
    // data access, and an unauthenticated caller can reach this branch.
    throw badRequest(`unknown operation ${JSON.stringify(name)}`);
  }

  return { ...params, query: GRAPHQL_OPERATIONS[name], operationName: name };
}

/** Yoga plugin wrapper. All of the logic lives in the pure function above so it
 *  can be tested without standing up a server. */
export function usePersistedOperations(opts: { allowArbitrary: boolean }) {
  return {
    onParams({
      params,
      setParams,
    }: {
      params: OperationParams;
      setParams: (p: OperationParams) => void;
    }) {
      setParams(resolvePersistedParams(params, opts));
    },
  };
}
