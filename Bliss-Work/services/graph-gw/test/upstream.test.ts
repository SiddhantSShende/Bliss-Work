/**
 * The upstream client: what happens when a backing service is slow, broken or
 * hostile, and the invariant that the caller's own credential is the only one
 * ever used.
 */
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, Upstream } from "../src/upstream.js";
import { AUTH_BASE, CALLER, jsonResponse, testConfig } from "./helpers.js";

const upstreamWith = (fetchImpl: typeof fetch, overrides = {}) =>
  new Upstream(testConfig(overrides), { fetchImpl });

describe("Upstream.get", () => {
  it("forwards the caller's Authorization header verbatim", async () => {
    // The gateway holds no credential of its own; RLS in every service is
    // derived from this token. Substituting one would defeat every tenant
    // boundary in the platform at once.
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    await upstreamWith(fetchImpl).get("auth-svc", AUTH_BASE, "/auth/me", CALLER);
    const headers = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
  });

  it("propagates trace headers so the gateway is not where traces die", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await upstreamWith(fetchImpl).get("auth-svc", AUTH_BASE, "/auth/me", {
      authorization: "Bearer t",
      forwarded: { traceparent: "00-abc-def-01", "x-request-id": "req-9" },
    });
    const headers = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.traceparent).toBe("00-abc-def-01");
    expect(headers["x-request-id"]).toBe("req-9");
  });

  it("maps an upstream status onto the platform's own error vocabulary", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { code: "forbidden", message: "not your org" } }, 403)) as typeof fetch;
    await expect(
      upstreamWith(fetchImpl).get("auth-svc", AUTH_BASE, "/auth/me", CALLER),
    ).rejects.toMatchObject({
      message: "not your org",
      extensions: { code: "forbidden", service: "auth-svc" },
    });
  });

  it("does not echo a non-envelope error body back to the client", async () => {
    // An upstream stack trace must not become a GraphQL error message.
    const fetchImpl = (async () =>
      new Response("Traceback: /app/service.py line 42, secret=hunter2", {
        status: 500,
      })) as typeof fetch;
    await expect(
      upstreamWith(fetchImpl).get("auth-svc", AUTH_BASE, "/auth/me", CALLER),
    ).rejects.toMatchObject({ message: "auth-svc responded 500" });
  });

  it("aborts a hung upstream at the deadline instead of pinning the resolver", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    await expect(
      upstreamWith(fetchImpl, { upstreamTimeoutMs: 10 }).get("auth-svc", AUTH_BASE, "/x", CALLER),
    ).rejects.toMatchObject({ extensions: { code: "gateway_timeout" } });
  });

  it("rejects malformed JSON rather than handing a resolver an unusable value", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(
      upstreamWith(fetchImpl).get("auth-svc", AUTH_BASE, "/x", CALLER),
    ).rejects.toMatchObject({ extensions: { code: "internal_error" } });
  });

  it("opens the breaker after repeated 5xx and then fails without a network call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const upstream = upstreamWith(fetchImpl, { breakerThreshold: 3, breakerResetMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(upstream.get("auth-svc", AUTH_BASE, "/x", CALLER)).rejects.toBeTruthy();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(upstream.get("auth-svc", AUTH_BASE, "/x", CALLER)).rejects.toMatchObject({
      extensions: { code: "service_unavailable" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // refused without touching the network
  });

  it("does not open the breaker on 4xx — that is the caller's fault", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;
    const upstream = upstreamWith(fetchImpl, { breakerThreshold: 2 });
    for (let i = 0; i < 5; i++) {
      await expect(upstream.get("auth-svc", AUTH_BASE, "/x", CALLER)).rejects.toBeTruthy();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("keeps one service's outage from tripping another's breaker", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("auth-svc") ? jsonResponse({}, 500) : jsonResponse([]),
    ) as unknown as typeof fetch;
    const upstream = upstreamWith(fetchImpl, { breakerThreshold: 2 });
    for (let i = 0; i < 3; i++) {
      await expect(upstream.get("auth-svc", AUTH_BASE, "/x", CALLER)).rejects.toBeTruthy();
    }
    await expect(
      upstream.get("messaging-svc", "http://messaging-svc:8004", "/y", CALLER),
    ).resolves.toEqual([]);
  });
});

describe("CircuitBreaker", () => {
  it("admits exactly one probe when the reset window elapses", () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1_000, () => now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    now = 1_001;
    expect(breaker.isOpen()).toBe(false); // the probe
    expect(breaker.isOpen()).toBe(true); // everything behind it still refused
  });

  it("closes fully once the probe succeeds", () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 100, () => now);
    breaker.recordFailure();
    now = 200;
    expect(breaker.isOpen()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  it("re-opens for a fresh window when the probe fails", () => {
    let now = 0;
    const breaker = new CircuitBreaker(1, 100, () => now);
    breaker.recordFailure();
    now = 200;
    expect(breaker.isOpen()).toBe(false); // probe admitted
    breaker.recordFailure(); // probe failed
    expect(breaker.isOpen()).toBe(true);
  });
});
