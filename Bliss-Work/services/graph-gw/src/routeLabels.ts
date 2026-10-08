/** Return a bounded HTTP metrics label for the gateway's registered routes. */
export function routeMetricPath(requestUrl: string): "/graphql" | "other" {
  const path = requestUrl.split("?")[0] ?? "/";
  return path === "/graphql" ? "/graphql" : "other";
}
