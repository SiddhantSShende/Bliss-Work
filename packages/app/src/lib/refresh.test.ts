/**
 * Tests for the single-flight session refresh (refresh.ts).
 *
 * The whole reason this module exists is correctness under concurrency: refresh
 * tokens ROTATE on every /auth/refresh and reusing a rotated token revokes the
 * whole family. So the load-bearing invariants are:
 *   1. concurrent callers share exactly ONE network call (single-flight), and
 *   2. a non-ok / malformed response fails CLEANLY (→ null) without ever
 *      writing partial/corrupt state into the session store.
 *
 * We stub global.fetch and reset the session store (and the module's in-flight
 * slot) between tests. fetch is held open via a deferred so we can assert that
 * two simultaneous calls coalesce before either resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDTO, type UserDTO } from "@taskboard/shared";
import { refreshSession } from "./refresh";
import { useSession } from "../store/session";

const AUTH = "http://auth.test";

const validUser: UserDTO = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  username: "alice",
  displayName: "Alice",
  email: "alice@acme.com",
  roles: ["member"],
  plan: "free",
};

const validSession: SessionDTO = {
  accessToken: "access-abc",
  user: validUser,
  expiresIn: 900,
};

/** A fetch Response stand-in — only the bits refresh.ts touches. */
function fakeResponse(ok: boolean, json: unknown): Response {
  return {
    ok,
    status: ok ? 200 : 401,
    json: () => Promise.resolve(json),
  } as unknown as Response;
}

/** A manually-settled promise so we can hold a fetch open mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// NOTE: we import refreshSession (and useSession) statically rather than
// re-importing per test. The module-level `inFlight` slot clears synchronously
// on settle (see refresh.ts `finally`), and every test below awaits its
// refresh to completion — so the slot is always empty at the next test's start.
// Static imports keep the SAME `useSession` store instance refresh.ts writes
// to, which is exactly what we assert on.
beforeEach(() => {
  // Known-anon starting state so we can detect any write into the store.
  useSession.setState({ user: null, accessToken: null, status: "anon" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("refreshSession single-flight", () => {
  it("coalesces concurrent calls into ONE fetch and shares the result", async () => {
    const d = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(d.promise);
    vi.stubGlobal("fetch", fetchMock);

    // Fire two refreshes before the first network call settles.
    const p1 = refreshSession(AUTH);
    const p2 = refreshSession(AUTH);

    // Single-flight: the second call must reuse the in-flight promise, not
    // open a second connection (which would revoke the rotating token).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    d.resolve(fakeResponse(true, validSession));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(validSession);
    expect(r2).toEqual(validSession);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // POST /auth/refresh with credentials so the rotating cookie rides along.
    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH}/auth/refresh`,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("releases the in-flight slot on settle so a later burst makes a fresh call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse(true, validSession));
    vi.stubGlobal("fetch", fetchMock);

    await refreshSession(AUTH);
    await refreshSession(AUTH); // second, sequential burst

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("on success writes user + accessToken to the session store and persists the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse(true, validSession)),
    );
    const persist = vi.fn();

    const res = await refreshSession(AUTH, persist);

    expect(res).toEqual(validSession);
    const st = useSession.getState();
    expect(st.user).toEqual(validUser);
    expect(st.accessToken).toBe("access-abc");
    expect(st.status).toBe("authed");
    expect(persist).toHaveBeenCalledExactlyOnceWith("access-abc");
  });
});

describe("refreshSession failure modes (never writes the session)", () => {
  it.each<[string, () => Response | Promise<never>]>([
    ["non-ok response (401)", () => fakeResponse(false, { error: "nope" })],
    [
      "malformed body — SessionDTO.safeParse rejects (missing user/expiresIn)",
      () => fakeResponse(true, { accessToken: "only-a-token" }),
    ],
    [
      "malformed body — user fails its uuid/email schema",
      () =>
        fakeResponse(true, {
          accessToken: "t",
          expiresIn: 900,
          user: { id: "not-a-uuid", username: "x" },
        }),
    ],
  ])("returns null and leaves the store untouched: %s", async (_label, makeRes) => {
    const persist = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeRes()));

    const res = await refreshSession(AUTH, persist);

    expect(res).toBeNull();
    const st = useSession.getState();
    expect(st.user).toBeNull();
    expect(st.accessToken).toBeNull();
    expect(st.status).toBe("anon"); // never flipped to "authed"
    expect(persist).not.toHaveBeenCalled();
  });

  it("swallows a thrown fetch (network error) and returns null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(refreshSession(AUTH)).resolves.toBeNull();
    expect(useSession.getState().status).toBe("anon");
  });

  it("a rejected fetch still clears the in-flight slot (next call retries)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("boom"))
      .mockResolvedValueOnce(fakeResponse(true, validSession));
    vi.stubGlobal("fetch", fetchMock);

    expect(await refreshSession(AUTH)).toBeNull();
    expect(await refreshSession(AUTH)).toEqual(validSession);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("SessionDTO.safeParse boundary (the validation refresh.ts relies on)", () => {
  it("accepts a well-formed session payload", () => {
    expect(SessionDTO.safeParse(validSession).success).toBe(true);
  });

  it("rejects a payload missing required fields", () => {
    expect(SessionDTO.safeParse({ accessToken: "x" }).success).toBe(false);
  });
});
