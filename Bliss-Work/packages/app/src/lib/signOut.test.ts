import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSession } from "../store/session";
import type { PlatformConfig } from "../platform";

/**
 * Signing out has to make the person go OFFLINE, and that is entirely a
 * question of ordering.
 *
 * Both goodbyes — the activity session's final beacon and the socket — are
 * authenticated, and both used to be left to React unmounting the shell, which
 * happens after the session store has been cleared. The beacon then went out
 * with no bearer and closed nothing, so an admin's Members list read the person
 * as Online until the server's sweeper caught up. These tests pin the order, not
 * the implementation.
 */

/** The access token as it stood at the moment the goodbye was sent. */
let tokenAtGoodbye: string | null | undefined;

vi.mock("./telemetry", () => ({
  endTelemetrySession: vi.fn(async () => {
    tokenAtGoodbye = useSession.getState().accessToken;
  }),
}));
const broadcastLogout = vi.fn();
vi.mock("./authChannel", () => ({ broadcastLogout: () => broadcastLogout() }));

const { signOut } = await import("./signOut");

const apiWith = (logout: () => Promise<unknown>) =>
  ({ logout }) as unknown as Parameters<typeof signOut>[0];

function webConfig(persist = vi.fn()): PlatformConfig {
  return { kind: "web", persistRefreshToken: persist } as unknown as PlatformConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenAtGoodbye = undefined;
  useSession.getState().setSession({
    user: { id: "u1" } as never,
    accessToken: "live-token",
    expiresIn: 900,
  });
});

describe("signOut", () => {
  it("says goodbye while the token is still valid, then clears the session", async () => {
    const ws = { close: vi.fn() };
    await signOut(apiWith(vi.fn().mockResolvedValue(undefined)), webConfig(), ws);

    // The whole bug in one assertion: a goodbye sent after the clear carries no
    // bearer, 401s, and leaves the person online.
    expect(tokenAtGoodbye).toBe("live-token");
    expect(useSession.getState().accessToken).toBeNull();
    expect(useSession.getState().status).toBe("anon");
  });

  it("closes the web build's own socket — presence is the socket", async () => {
    const ws = { close: vi.fn() };
    await signOut(apiWith(vi.fn().mockResolvedValue(undefined)), webConfig(), ws);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("asks the desktop host to hang up instead, and never both", async () => {
    // The desktop's socket lives in a utilityProcess that outlives the window,
    // so nothing the renderer unmounts can reach it.
    const disconnect = vi.fn();
    const ws = { close: vi.fn() };
    const config = {
      kind: "electron",
      eventSource: { connect: vi.fn(), disconnect, subscribe: vi.fn() },
      persistRefreshToken: vi.fn(),
    } as unknown as PlatformConfig;

    await signOut(apiWith(vi.fn().mockResolvedValue(undefined)), config, ws);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("clears the persisted refresh token so the next launch does not restore the session", async () => {
    const persist = vi.fn();
    await signOut(apiWith(vi.fn().mockResolvedValue(undefined)), webConfig(persist), {
      close: vi.fn(),
    });
    expect(persist).toHaveBeenCalledWith(null);
    expect(broadcastLogout).toHaveBeenCalledTimes(1);
  });

  it("signs the user out even when the network is gone", async () => {
    // A failed revoke must not strand someone in a signed-in-looking UI. The
    // server-side sweeper and the socket timeout are the backstop.
    const ws = { close: vi.fn() };
    await signOut(apiWith(vi.fn().mockRejectedValue(new Error("offline"))), webConfig(), ws);

    expect(useSession.getState().status).toBe("anon");
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});
