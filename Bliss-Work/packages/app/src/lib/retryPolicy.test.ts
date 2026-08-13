import { describe, expect, it } from "vitest";
import { ApiError } from "@taskboard/shared";
import { queryRetryDelay, shouldRetryQuery } from "./retryPolicy";

/**
 * The bug this pins down: every query on screen failed at once with
 * ERR_NETWORK_CHANGED (a Wi-Fi/VPN/sleep transition aborts all in-flight
 * sockets), and the old policy burned its 3 attempts inside ~600ms — entirely
 * within the dead window — so the UI stuck on an error.
 */

/** What `fetch` rejects with when the transport dies; ApiClient re-throws raw. */
const networkError = () => new TypeError("Failed to fetch");

describe("shouldRetryQuery", () => {
  it("keeps retrying a transport failure long enough to outlast a network change", () => {
    // The old policy stopped at failureCount 2 (~600ms of coverage).
    expect(shouldRetryQuery(2, networkError())).toBe(true);
    expect(shouldRetryQuery(4, networkError())).toBe(true);
  });

  it("still gives up on a transport failure eventually", () => {
    expect(shouldRetryQuery(5, networkError())).toBe(false);
  });

  it("retries a 5xx, briefly", () => {
    expect(shouldRetryQuery(0, new ApiError(503, "unavailable"))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError(503, "unavailable"))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError(503, "unavailable"))).toBe(false);
  });

  it("retries our own client-side timeout", () => {
    // 408 is ApiClient aborting the fetch — a transport symptom, and a common
    // shape for an in-flight request caught by a network change.
    expect(shouldRetryQuery(0, new ApiError(408, "request timed out"))).toBe(true);
  });

  it("never retries a real client error", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetryQuery(0, new ApiError(status, "nope"))).toBe(false);
    }
  });
});

describe("queryRetryDelay", () => {
  it("backs off transport failures across a multi-second window", () => {
    const total = [0, 1, 2, 3, 4]
      .map((a) => queryRetryDelay(a, networkError()))
      .reduce((a, b) => a + b, 0);
    // The whole point: cover seconds, not the old ~600ms.
    expect(total).toBeGreaterThanOrEqual(15_000);
  });

  it("caps the transport backoff so a retry is never far away", () => {
    expect(queryRetryDelay(10, networkError())).toBe(8_000);
  });

  it("keeps HTTP retries snappy", () => {
    expect(queryRetryDelay(0, new ApiError(500, "boom"))).toBe(200);
    expect(queryRetryDelay(10, new ApiError(500, "boom"))).toBe(2_000);
  });
});
