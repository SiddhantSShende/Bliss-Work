import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { ensureFreshSession, isOffline, isSessionDead, refreshSession } from "./refresh";

const AUTH = "https://auth.example.test";
const USER: SessionDTO["user"] = {
  id: "0d0c1c0e-6a52-4d54-9d0b-3f6a3d3a7f11",
  orgId: "5b7f2a4e-7c26-4a35-8f0d-0e6f0a6f9c22",
  orgName: "Acme",
  username: "sam",
  displayName: "Sam",
  email: "sam@example.test",
  roles: ["member"],
  plan: "free",
  avatarUrl: null,
  mfaEnrolled: false,
  orgRequireMfaForAdmins: false,
  orgMfaGracePeriodEndsAt: null,
  themePrefs: null,
};

const setOnline = (online: boolean) =>
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);

/** Signed in, with a token that lapses `expiresInMs` from now (negative = already lapsed). */
function signInExpiringIn(expiresInMs: number) {
  useSession.getState().setSession({ user: USER, accessToken: "old-token", expiresIn: 900 });
  useSession.setState({ expiresAt: Date.now() + expiresInMs });
}

function refreshReplies(body: SessionDTO | { code: string }, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T09:00:00Z"));
  setOnline(true);
});
afterEach(() => {
  useSession.getState().clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refreshSession while offline", () => {
  it("answers null without making a request", async () => {
    const fetchMock = refreshReplies({ code: "unused" });
    setOnline(false);

    await expect(refreshSession(AUTH)).resolves.toBeNull();

    expect(isOffline()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshSession with an invalid refresh token", () => {
  it("treats the server's unknown-token response as terminal instead of retrying forever", async () => {
    signInExpiringIn(-1_000);
    refreshReplies({ code: "unknown" }, 401);

    await expect(refreshSession(AUTH)).resolves.toBeNull();

    expect(isSessionDead()).toBe(true);
    expect(useSession.getState().status).toBe("anon");
    useSession.getState().setSession({ user: USER, accessToken: "reset-token", expiresIn: 900 });
  });
});

describe("ensureFreshSession", () => {
  it("is true with no request when the token still has time on it", async () => {
    signInExpiringIn(10 * 60_000);
    const fetchMock = refreshReplies({ code: "unused" });

    await expect(ensureFreshSession(AUTH)).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is false when signed out, without a request", async () => {
    const fetchMock = refreshReplies({ code: "unused" });

    await expect(ensureFreshSession(AUTH)).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is false offline even with a lapsed token, without a request", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = refreshReplies({ code: "unused" });
    setOnline(false);

    await expect(ensureFreshSession(AUTH)).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a lapsed token first and reports true", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = refreshReplies({ accessToken: "new-token", user: USER, expiresIn: 900 });

    await expect(ensureFreshSession(AUTH)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useSession.getState().accessToken).toBe("new-token");
  });

  it("treats a token about to lapse as lapsed", async () => {
    signInExpiringIn(2_000);
    const fetchMock = refreshReplies({ accessToken: "new-token", user: USER, expiresIn: 900 });

    await expect(ensureFreshSession(AUTH)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("is false when the refresh fails, leaving the session for the caller's own handling", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFreshSession(AUTH)).resolves.toBe(false);

    expect(useSession.getState().accessToken).toBe("old-token");
  });
});

describe("refreshSession single-flight", () => {
  it("shares one in-flight network call across concurrent callers", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = refreshReplies({ accessToken: "new-token", user: USER, expiresIn: 900 });

    const [a, b] = await Promise.all([refreshSession(AUTH), refreshSession(AUTH)]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(a).toEqual(b);
    expect(useSession.getState().accessToken).toBe("new-token");
  });
});

describe("refreshSession racing a sign-out", () => {
  // The bug: performRefresh used to write a successful result into the store
  // unconditionally. A refresh that was already on the wire when the user
  // clicked "sign out" would land afterwards and silently flip the UI back to
  // signed-in — exactly the "resurrecting a stale session" failure mode.
  it("does not resurrect the session if the user signs out while the refresh is in flight", async () => {
    signInExpiringIn(-1_000);
    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const persist = vi.fn();

    const pending = refreshSession(AUTH, persist);

    // The sign-out button clears the store while the request above is still
    // in flight — this is what signOut.ts does before the network call here
    // resolves.
    useSession.getState().clear();

    resolveFetch(
      new Response(JSON.stringify({ accessToken: "new-token", user: USER, expiresIn: 900 }), {
        status: 200,
      }),
    );

    await expect(pending).resolves.toBeNull();
    expect(useSession.getState().status).toBe("anon");
    expect(useSession.getState().accessToken).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not let a stale refresh clobber a session the user just signed into", async () => {
    signInExpiringIn(-1_000);
    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshSession(AUTH);

    // A fresh login completes while the old refresh above is still in flight.
    const NEW_USER: SessionDTO["user"] = { ...USER, id: "a-different-user-id" };
    useSession.getState().setSession({ user: NEW_USER, accessToken: "login-token", expiresIn: 900 });

    resolveFetch(
      new Response(JSON.stringify({ accessToken: "stale-token", user: USER, expiresIn: 900 }), {
        status: 200,
      }),
    );

    await expect(pending).resolves.toBeNull();
    expect(useSession.getState().accessToken).toBe("login-token");
    expect(useSession.getState().user).toEqual(NEW_USER);
  });
});

describe("refreshSession on desktop (body-token fallback)", () => {
  // The packaged renderer is file://, so the SameSite=lax refresh cookie never
  // travels — the host hands the token over explicitly instead. See
  // apps/desktop/src/main/session-token.ts.
  it("sends the host-provided token in the request body", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = refreshReplies({ accessToken: "new-token", user: USER, expiresIn: 900 });
    const getRefreshToken = vi.fn(async () => "desktop-mirrored-token");

    await refreshSession(AUTH, undefined, getRefreshToken);

    expect(getRefreshToken).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({ token: "desktop-mirrored-token" });
  });

  it("falls back to the cookie-only request when the host has no token yet", async () => {
    signInExpiringIn(-1_000);
    const fetchMock = refreshReplies({ accessToken: "new-token", user: USER, expiresIn: 900 });
    const getRefreshToken = vi.fn(async () => null);

    await refreshSession(AUTH, undefined, getRefreshToken);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
  });
});
