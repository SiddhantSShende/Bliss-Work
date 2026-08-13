import { ApiError } from "@taskboard/shared";

/**
 * Query retry policy.
 *
 * Two very different failure modes reach this predicate, and they deserve
 * different amounts of patience:
 *
 *   - A response came back. 4xx is a real client error that will fail
 *     identically on retry; only a 5xx (or our own timeout) is worth another
 *     look, and only briefly.
 *   - No response at all — `fetch` itself rejected. ApiClient deliberately
 *     re-throws these raw (client.ts: "network / DNS failure — surface as-is"),
 *     so they arrive here as a bare TypeError rather than an ApiError.
 *     ERR_NETWORK_CHANGED is the common one: a Wi-Fi ↔ ethernet handoff, VPN
 *     toggle or sleep/wake makes Chrome abort every in-flight socket at once,
 *     which is why such a failure arrives for every query on screen at the same
 *     instant.
 *
 * The previous policy spent its entire budget — 2 retries at 200ms + 400ms —
 * inside ~600ms. A network transition lasts seconds, so all three attempts
 * landed in the dead window and the query failed permanently. Two other
 * defaults then conspired to make that stick: `refetchOnWindowFocus` is off, and
 * `navigator.onLine` frequently stays TRUE across an interface change, so
 * react-query's refetchOnReconnect never fires either. The UI sat on an error
 * until something remounted it past staleTime.
 *
 * So: transport failures get a ~15s budget, HTTP failures keep the short one.
 */

const HTTP_MAX_RETRIES = 2;
/** 0.5 + 1 + 2 + 4 + 8 ≈ 15s — long enough to outlast a typical interface change. */
const NETWORK_MAX_RETRIES = 5;

/** No HTTP response: `fetch` rejected (DNS, offline, ERR_NETWORK_CHANGED, …). */
export function isTransportError(error: unknown): boolean {
  return !(error instanceof ApiError);
}

/** 408 is ApiClient's OWN client-side timeout (it aborts the fetch), so it is a
 *  transport symptom rather than a client mistake — during a network change an
 *  in-flight request often times out instead of rejecting outright. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isTransportError(error)) return failureCount < NETWORK_MAX_RETRIES;
  return failureCount < HTTP_MAX_RETRIES && isTransientStatus((error as ApiError).status);
}

export function queryRetryDelay(attempt: number, error: unknown): number {
  return isTransportError(error)
    ? Math.min(500 * 2 ** attempt, 8_000)
    : Math.min(200 * 2 ** attempt, 2_000);
}
