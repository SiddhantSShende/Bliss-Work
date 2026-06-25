/**
 * Tests for ApiClient request timeout (client.ts `req`).
 *
 * A stalled TCP connection must NOT pin a request — and the UI state waiting on
 * it — open forever. `req` arms an AbortController for `timeoutMs` and, when the
 * resulting AbortError surfaces, rethrows it as a typed 408 ApiError. We drive
 * this with fake timers + a fetch stub that only settles when its signal aborts,
 * so the test never actually waits real wall-clock time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

/** A fetch that never resolves on its own — it only REJECTS, with a real
 *  AbortError DOMException, when the passed AbortSignal fires (mirroring how the
 *  platform fetch behaves on controller.abort()). */
function hangingFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hang forever; the test should never hit this
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;
}

function makeClient(timeoutMs: number, fetchImpl: typeof fetch): ApiClient {
  vi.stubGlobal("fetch", fetchImpl);
  return new ApiClient({
    authBase: "http://auth.test",
    taskBase: "http://task.test",
    messagingBase: "http://msg.test",
    notificationBase: "http://notif.test",
    presenceBase: "http://presence.test",
    getToken: () => null,
    timeoutMs,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApiClient request timeout", () => {
  it("aborts a never-resolving fetch after timeoutMs and throws a 408 ApiError", async () => {
    const client = makeClient(50, hangingFetch());

    // login() is just a thin wrapper over the private req(); any method exercises
    // the same timeout path. Capture the promise BEFORE advancing timers.
    const promise = client.login({ email: "a@b.com", password: "pw" });
    const assertion = expect(promise).rejects.toMatchObject({
      status: 408,
      name: "ApiError",
    });

    // Fire the abort timer; the fetch stub rejects with AbortError, which req
    // maps to the 408 ApiError.
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("the thrown error is an ApiError whose code derives from status 408", async () => {
    const client = makeClient(50, hangingFetch());

    const promise = client.me();
    const caught = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(408);
    expect((err as ApiError).message).toContain("timed out after 50ms");
    // httpStatusToCode has no 408-specific mapping (only 504 → gateway_timeout),
    // so a 408 falls through to the generic 4xx code. Pinning the real value.
    expect((err as ApiError).code).toBe("bad_request");
  });

  it("does NOT time out before timeoutMs elapses", async () => {
    const client = makeClient(1000, hangingFetch());

    const promise = client.me();
    const settled = vi.fn();
    void promise.then(settled, settled);

    // Just shy of the deadline — the abort timer hasn't fired yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();

    // Crossing the deadline aborts and rejects.
    await vi.advanceTimersByTimeAsync(1);
    await promise.catch(() => {});
    expect(settled).toHaveBeenCalledOnce();
  });

  it("a fast successful response clears the timer and never throws 408", async () => {
    // me() now validates its response against UserDTO, so the stubbed body must
    // be a well-formed user (otherwise req() throws a 502, not a 408 — but the
    // intent here is purely the timer-clearing path, so feed it a valid DTO).
    const user = {
      id: "11111111-1111-1111-1111-111111111111",
      orgId: "22222222-2222-2222-2222-222222222222",
      username: "alice",
      displayName: "Alice",
      email: "alice@acme.com",
      roles: ["member"],
    };
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(user),
    } as unknown as Response);

    const client = makeClient(50, okFetch as unknown as typeof fetch);
    const result = await client.me();

    expect(result).toEqual(user);
    // Advancing past the (now-cleared) timeout must not blow anything up.
    await vi.advanceTimersByTimeAsync(100);
    expect(okFetch).toHaveBeenCalledTimes(1);
  });
});
