/** The request's path, with the query string removed. Used for route dispatch
 *  — unlike {@link routeMetricPath}, this is NOT bounded, so it must never be
 *  used as a metrics label. */
export function requestPath(requestUrl: string): string {
  return requestUrl.split("?")[0] ?? "/";
}

export type AdminRoute = "/healthz" | "/readyz" | "/metrics";

const ADMIN_ROUTES: ReadonlySet<string> = new Set(["/healthz", "/readyz", "/metrics"]);

/** Which admin route (if any) a request's path matches, or null for
 *  everything else (GraphQL included). The HTTP server dispatches on this —
 *  never on {@link routeMetricPath}, which collapses these same three paths
 *  to the bounded "other" label and so can never match them. */
export function matchAdminRoute(requestUrl: string): AdminRoute | null {
  const path = requestPath(requestUrl);
  return ADMIN_ROUTES.has(path) ? (path as AdminRoute) : null;
}

/** Return a bounded HTTP metrics label for the gateway's registered routes. */
export function routeMetricPath(requestUrl: string): "/graphql" | "other" {
  return requestPath(requestUrl) === "/graphql" ? "/graphql" : "other";
}
