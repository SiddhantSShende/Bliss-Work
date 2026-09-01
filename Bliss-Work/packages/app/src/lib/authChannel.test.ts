/**
 * Cross-tab auth coordination (authChannel.ts + refresh.ts integration).
 *
 * The bug this guards against: rotating refresh tokens mean two tabs refreshing
 * the SAME cookie concurrently make one present an already-rotated token →
 * backend reuse-detection revokes the family → BOTH tabs log out. The fixes:
 *   - refreshSession serializes across tabs with the Web Locks API, and
 *   - a session a sibling tab broadcast moments ago is ADOPTED instead of
 *     triggering a second token rotation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDTO, UserDTO } from "@taskboard/shared";
import { installAuthChannel, getRecentSession, broadcastLogout, requestSession } from "./authChannel";
import { refreshSession } from "./refresh";
import { useSession } from "../store/session";

const AUTH = "http://auth.test";
const user: UserDTO = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "22222222-2222-2222-2222-222222222222",
  username: "alice",
  displayName: "Alice",
  email: "alice@acme.com",
  roles: ["member"],
  plan: "free",
  orgName: "Test Org",
  avatarUrl: null,
  mfaEnrolled: false,
  orgRequireMfaForAdmins: false,
  orgMfaGracePeriodEndsAt: null,
};
const session: SessionDTO = { accessToken: "sib-token", user, expiresIn: 900 };

// Minimal controllable BroadcastChannel so we can drive onmessage in the test.
let lastChannel: FakeChannel | null = null;
class FakeChannel {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  /** What this "tab" has posted — real cross-window delivery isn't
   *  simulated (see `deliver` below), so tests that need to observe an
   *  outgoing message (e.g. answering a sibling's request-session) read it
   *  from here instead. */
  posted: unknown[] = [];
  constructor(public name: string) {
    lastChannel = this;
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  close() {}
}

beforeEach(() => {
  useSession.setState({ user: null, accessToken: null, status: "anon" });
  vi.stubGlobal("BroadcastChannel", FakeChannel as unknown as typeof BroadcastChannel);
  installAuthChannel(); // idempotent; wires onmessage on the FakeChannel
  if (lastChannel) lastChannel.posted = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deliver(data: unknown) {
  lastChannel?.onmessage?.({ data } as MessageEvent);
}

describe("authChannel", () => {
  it("adopts a sibling-broadcast session into the store and exposes it as recent", () => {
    deliver({ type: "session", session });
    const st = useSession.getState();
    expect(st.status).toBe("authed");
    expect(st.accessToken).toBe("sib-token");
    expect(getRecentSession()).toEqual(session);
  });

  it("getRecentSession expires outside its freshness window", () => {
    deliver({ type: "session", session });
    expect(getRecentSession(0)).toBeNull(); // 0ms window ⇒ already stale
  });

  it("a sibling logout clears the store and forgets the recent session", () => {
    deliver({ type: "session", session });
    deliver({ type: "logout" });
    expect(useSession.getState().status).toBe("anon");
    expect(getRecentSession()).toBeNull();
  });
});

describe("refreshSession cross-tab", () => {
  it("short-circuits (no network refresh) when a sibling just broadcast a session", async () => {
    deliver({ type: "session", session }); // sibling refreshed moments ago
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await refreshSession(AUTH);

    expect(fetchMock).not.toHaveBeenCalled(); // adopted the sibling token instead
    expect(res).toEqual(session);
    expect(useSession.getState().accessToken).toBe("sib-token");
  });

  it("uses the Web Locks API to serialize refreshes when available", async () => {
    deliver({ type: "logout" }); // clear any recent sibling session
    const request = vi.fn(<T,>(_name: string, cb: () => Promise<T>) => cb());
    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(session) }),
    );

    await refreshSession(AUTH);

    expect(request).toHaveBeenCalledWith("tb-auth-refresh", expect.any(Function));
  });
});

/**
 * requestSession — built for the Electron meeting window (see
 * PlatformConfig.bootstrapFromPeerSession): it has no credential IPC of its
 * own, so it asks a sibling window for the session it already holds instead.
 */
describe("requestSession", () => {
  it("resolves with the session a sibling answers with", async () => {
    const pending = requestSession();
    deliver({ type: "session", session });
    await expect(pending).resolves.toEqual(session);
  });

  it("resolves null if nobody answers within the timeout", async () => {
    vi.useFakeTimers();
    const pending = requestSession(50);
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});

/** The other half of the same round trip: this tab answering a sibling's
 *  request. */
describe("answering a sibling's request-session", () => {
  it("broadcasts its own session when signed in", () => {
    deliver({ type: "session", session }); // this tab adopts one first
    lastChannel!.posted = []; // adopting itself never posts; clear for clarity
    deliver({ type: "request-session" });

    expect(lastChannel?.posted).toEqual([
      expect.objectContaining({ type: "session", session: expect.objectContaining({ accessToken: "sib-token" }) }),
    ]);
  });

  it("stays silent when signed out — nothing to offer a peer", () => {
    deliver({ type: "request-session" });
    expect(lastChannel?.posted).toEqual([]);
  });
});

// Keep the linter happy about the otherwise-unused export surface.
void broadcastLogout;
