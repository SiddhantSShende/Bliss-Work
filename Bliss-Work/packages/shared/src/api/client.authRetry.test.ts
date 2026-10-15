/**
 * req()'s 401 → refresh → retry path, under BURST concurrency — the pattern
 * ChannelView/DMView actually produce on mount (messages + reactions +
 * unread-counts firing together). Mirrors runtime.tsx's real wiring: a single
 * mutable "session" stands in for the zustand store, and `refreshToken` is a
 * SINGLE-FLIGHT promise shared across every concurrent caller, exactly like
 * lib/refresh.ts's `inFlight`.
 *
 * Investigates: "browser console shows 403/401 'missing bearer token' on
 * specific messaging requests while others work." If req() ever omits the
 * Authorization header on a request made while the in-memory session holds a
 * truthy token, this test catches it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiClient.req() under concurrent 401 + refresh", () => {
  it("every concurrent request, old and retried, carries a real Authorization header", () => {
    return (async () => {
      // Mirrors store/session.ts: one mutable in-memory "session".
      let session = { accessToken: "expired-token" as string | null };
      const getToken = () => session.accessToken;

      // Mirrors lib/refresh.ts's single-flight `inFlight` promise, shared by
      // every concurrent caller (runtime.tsx's `refreshToken` config field).
      let inFlight: Promise<string | null> | null = null;
      let refreshCalls = 0;
      const refreshToken = () => {
        if (inFlight) return inFlight;
        refreshCalls += 1;
        inFlight = new Promise<string | null>((resolve) => {
          setTimeout(() => {
            session = { accessToken: "fresh-token" };
            inFlight = null;
            resolve("fresh-token");
          }, 5);
        });
        return inFlight;
      };

      const seenAuthHeaders: (string | null)[] = [];
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
        seenAuthHeaders.push(auth);
        // The CURRENT in-memory token is what decides whether this call 401s —
        // exactly what the expired-access-token / proactive-refresh race looks
        // like against a real backend.
        if (auth === "Bearer fresh-token") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response('{"error":"missing bearer token"}', { status: 401 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const api = new ApiClient({
        authBase: "http://auth.test",
        taskBase: "http://task.test",
        messagingBase: "http://messaging.test",
        telemetryBase: "http://telemetry.test",
        notificationBase: "http://notification.test",
        presenceBase: "http://presence.test",
        getToken,
        refreshToken,
      } as never);

      const schema = z.object({ ok: z.boolean() });
      const req = (path: string) =>
        (
          api as unknown as {
            req: <T>(base: string, path: string, init: RequestInit, schema: z.ZodType<T>) => Promise<T>;
          }
        ).req("http://messaging.test", path, {}, schema);

      // The exact burst a ChannelView/DMView mount fires: messages, reactions,
      // unread-counts, all in flight together while the token is expired.
      const results = await Promise.all([
        req("/api/v1/channels/c1/messages"),
        req("/api/v1/channels/c1/reactions"),
        req("/api/v1/conversations/d1/reply"),
      ]);

      for (const r of results) expect(r).toEqual({ ok: true });

      // Every attempt — the first, 401'd one AND the retried one — must have
      // carried SOME Authorization header. A null entry here is exactly the
      // reported bug: a request reaching the server with the header omitted.
      expect(seenAuthHeaders.every((h) => h !== null)).toBe(true);
      expect(seenAuthHeaders.filter((h) => h === "Bearer expired-token")).toHaveLength(3);
      expect(seenAuthHeaders.filter((h) => h === "Bearer fresh-token")).toHaveLength(3);

      // Single-flight: three concurrent 401s must trigger exactly ONE network
      // refresh, not three.
      expect(refreshCalls).toBe(1);
    })();
  });
});

describe("ApiClient.req()'s TEMPORARY authDiag instrumentation", () => {
  const baseCfg = {
    authBase: "http://auth.test",
    taskBase: "http://task.test",
    messagingBase: "http://messaging.test",
    telemetryBase: "http://telemetry.test",
    notificationBase: "http://notification.test",
    presenceBase: "http://presence.test",
  };

  const callReq = (api: ApiClient, path: string, method = "GET") =>
    (
      api as unknown as {
        req: (base: string, path: string, init: RequestInit) => Promise<unknown>;
      }
    ).req("http://messaging.test", path, { method });

  it("reports bearerPresent=false and attaches no Authorization header when the session has no token — the exact reported symptom", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{"error":"missing bearer token"}', { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const api = new ApiClient({ ...baseCfg, getToken: () => null } as never);
    await expect(callReq(api, "/api/v1/channels/c1/reactions")).rejects.toThrow();

    const sentHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBeUndefined();

    const requestLog = infoSpy.mock.calls.find((c) => c[0] === "[authDiag:request]");
    expect(requestLog?.[1]).toMatchObject({ bearerPresent: false, path: "/api/v1/channels/c1/reactions" });
  });

  it("carries the SAME x-request-id across a 401-triggered retry", async () => {
    let session: string | null = "expired";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.authorization === "Bearer fresh") {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response('{"error":"missing bearer token"}', { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient({
      ...baseCfg,
      getToken: () => session,
      refreshToken: async () => {
        session = "fresh";
        return "fresh";
      },
    } as never);
    await callReq(api, "/api/v1/conversations/d1/reply", "POST");

    expect(fetchMock.mock.calls).toHaveLength(2);
    const [firstHeaders, secondHeaders] = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string>)["x-request-id"],
    );
    expect(firstHeaders).toBeTruthy();
    expect(secondHeaders).toBe(firstHeaders);
  });

  it("never logs the token itself, only whether a Bearer header was attached", async () => {
    const secretToken = "super-secret-access-token-value";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const api = new ApiClient({ ...baseCfg, getToken: () => secretToken } as never);
    await callReq(api, "/api/v1/channels/c1/messages");

    for (const call of infoSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secretToken);
    }
  });
});
