/**
 * What happens when a refresh CANNOT succeed.
 *
 * The incident: auth-svc revoked a token family, and the app kept presenting the
 * dead cookie — one refresh per 401'd request, with a presence poll firing every
 * 20s — for eight minutes, while the UI still looked signed in. A failed refresh
 * is usually transient and deliberately non-destructive; a revoked family is
 * neither, and the two must be told apart.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const AUTH = "https://example.test/api/auth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  accessToken: "at",
  expiresIn: 900,
  user: {
    id: "11111111-1111-1111-1111-111111111111",
    orgId: "22222222-2222-2222-2222-222222222222",
    orgName: "Org",
    username: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    roles: ["member"],
    plan: "free",
  },
};

/** Fresh module per test — the circuit breaker is module state by design.
 *  The session store must come from the SAME fresh graph, or the assertions
 *  would inspect a different store instance than refresh.ts is writing to. */
async function loadRefresh() {
  vi.resetModules();
  const { useSession } = await import("../store/session");
  const mod = await import("./refresh");
  useSession.getState().setSession({ user: SESSION.user as never, accessToken: "at", expiresIn: 900 });
  return { ...mod, useSession };
}

describe("refreshSession", () => {
  beforeEach(() => {
    // navigator.locks is absent in jsdom; the code degrades to single-flight.
    vi.restoreAllMocks();
  });

  it("stores the new session on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, SESSION)));
    const { refreshSession, useSession } = await loadRefresh();

    const s = await refreshSession(AUTH);

    expect(s?.accessToken).toBe("at");
    expect(useSession.getState().status).toBe("authed");
  });

  it("keeps the session on a transient failure", async () => {
    // A 5xx or a blip is NOT evidence the session is over — the current access
    // token is usually still good, and bouncing the user would be wrong.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const { refreshSession, isSessionDead, useSession } = await loadRefresh();

    expect(await refreshSession(AUTH)).toBeNull();
    expect(useSession.getState().status).toBe("authed");
    expect(isSessionDead()).toBe(false);
  });

  it("keeps the session when the request simply had no cookie", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { code: "missing" })));
    const { refreshSession, isSessionDead, useSession } = await loadRefresh();

    expect(await refreshSession(AUTH)).toBeNull();
    expect(useSession.getState().status).toBe("authed");
    expect(isSessionDead()).toBe(false);
  });

  it("signs the user out when the token family was revoked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { code: "reused" })));
    const persist = vi.fn();
    const { refreshSession, isSessionDead, useSession } = await loadRefresh();

    expect(await refreshSession(AUTH, persist)).toBeNull();

    expect(useSession.getState().status).toBe("anon");
    expect(persist).toHaveBeenCalledWith(null);
    expect(isSessionDead()).toBe(true);
  });

  // An admin suspending or removing someone revokes every refresh family in the
  // same transaction. The target is still holding a valid access token for up to
  // ~15 more minutes, so the refresh 401 is the moment their session actually
  // ends — treating 'deactivated' as transient would leave a removed member
  // looking signed in while every request quietly failed underneath them.
  it("signs the user out when their membership was deactivated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { code: "deactivated" })));
    const persist = vi.fn();
    const { refreshSession, isSessionDead, useSession } = await loadRefresh();

    expect(await refreshSession(AUTH, persist)).toBeNull();

    expect(useSession.getState().status).toBe("anon");
    expect(persist).toHaveBeenCalledWith(null);
    expect(isSessionDead()).toBe(true);
  });

  // The loop itself: without this, every 401'd request and every 20s presence
  // poll fires another doomed refresh, forever.
  it("stops hitting the network once the session is dead", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { code: "reused" }));
    vi.stubGlobal("fetch", fetchMock);
    const { refreshSession } = await loadRefresh();

    await refreshSession(AUTH);
    await refreshSession(AUTH);
    await refreshSession(AUTH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the breaker again after a fresh sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { code: "expired" })));
    const { refreshSession, isSessionDead, useSession } = await loadRefresh();

    await refreshSession(AUTH);
    expect(isSessionDead()).toBe(true);

    // Signing in mints a NEW family — every login path routes through the store.
    useSession.getState().setSession({ user: SESSION.user as never, accessToken: "new", expiresIn: 900 });
    expect(isSessionDead()).toBe(false);
  });
});
