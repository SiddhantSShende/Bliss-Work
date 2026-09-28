import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { ensureFreshSession, isOffline, refreshSession } from "./refresh";

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
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
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
