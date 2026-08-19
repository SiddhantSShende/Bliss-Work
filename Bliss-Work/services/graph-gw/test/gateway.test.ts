/**
 * End-to-end through a real Yoga instance — real plugins, real validation, real
 * resolvers — with only the network stubbed.
 *
 * The headline assertion is the one the whole project rests on: rendering N
 * inbox rows must cost ONE call to auth-svc, not N, and not a fetch of the
 * entire organisation directory. It is asserted by counting upstream calls
 * rather than by reading the resolvers, so a future change that reintroduces
 * the N+1 fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/server.js";
import { jsonResponse, peerRow, testConfig, U, userRow } from "./helpers.js";

interface UpstreamStub {
  peers?: unknown;
  users?: Record<string, string>;
  authStatus?: number;
}

/** Stubs both backing services and records what was called. */
function stubServices({ peers = [], users = {}, authStatus }: UpstreamStub) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const target = new URL(String(url));
    calls.push(`${target.pathname}${target.search}`);

    if (target.pathname === "/api/v1/inbox/peers") return jsonResponse(peers);
    if (target.pathname === "/auth/me") return jsonResponse(userRow(U(99), "Me"));
    if (target.pathname === "/auth/users") {
      if (authStatus) return jsonResponse({ error: { message: "down" } }, authStatus);
      const ids = target.searchParams.get("ids")!.split(",");
      return jsonResponse(ids.filter((id) => users[id]).map((id) => userRow(id, users[id]!)));
    }
    return jsonResponse({ error: { message: "unexpected path" } }, 404);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const AUTHED = { authorization: "Bearer token-for-alice" };

async function run(
  stub: UpstreamStub,
  init: { headers?: Record<string, string>; search?: string; body?: unknown } = {},
) {
  const { fetchImpl, calls } = stubServices(stub);
  const { yoga } = createGateway(testConfig(), { fetchImpl });

  const search =
    init.search ??
    `?operationName=InboxOverview&variables=${encodeURIComponent(JSON.stringify({ kinds: ["MAIL"] }))}`;

  const response = init.body
    ? await yoga.fetch("http://gw/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", ...(init.headers ?? AUTHED) },
        body: JSON.stringify(init.body),
      })
    : await yoga.fetch(`http://gw/graphql${search}`, {
        method: "GET",
        headers: init.headers ?? AUTHED,
      });

  return { response, body: (await response.json()) as any, calls };
}

describe("InboxOverview — the pilot", () => {
  const TEN_PEERS = Array.from({ length: 10 }, (_, i) => peerRow(U(i + 1), `Peer${i + 1}`));
  const TEN_USERS = Object.fromEntries(TEN_PEERS.map((p, i) => [p.peerId, `Peer${i + 1}`]));

  it("resolves ten rows with ONE call to auth-svc", async () => {
    const { body, calls } = await run({ peers: TEN_PEERS, users: TEN_USERS });

    expect(body.errors).toBeUndefined();
    expect(body.data.inboxPeers).toHaveLength(10);

    const authCalls = calls.filter((c) => c.startsWith("/auth/users"));
    expect(authCalls).toHaveLength(1);
  });

  it("asks auth-svc for exactly the ten people on screen, not the directory", async () => {
    // This is the over-fetch the pilot exists to remove: the screen used to pull
    // every member of the org (up to 5,000 rows) to put an address on ten rows.
    const { calls } = await run({ peers: TEN_PEERS, users: TEN_USERS });

    const authCall = calls.find((c) => c.startsWith("/auth/users"))!;
    expect(authCall).not.toContain("/auth/directory");
    expect(new URLSearchParams(authCall.split("?")[1]).get("ids")!.split(",")).toHaveLength(10);
  });

  it("joins each row to its own person", async () => {
    const { body } = await run({ peers: TEN_PEERS, users: TEN_USERS });

    for (const peer of body.data.inboxPeers) {
      expect(peer.user.id).toBe(peer.peerId);
      expect(peer.user.email).toBe(`${peer.user.displayName.toLowerCase()}@acme.test`);
    }
  });

  it("makes one upstream call per service, total", async () => {
    const { calls } = await run({ peers: TEN_PEERS, users: TEN_USERS });
    expect(calls).toHaveLength(2);
  });

  it("passes the requested kinds through to messaging-svc", async () => {
    const { calls } = await run({ peers: TEN_PEERS, users: TEN_USERS });
    expect(calls.find((c) => c.startsWith("/api/v1/inbox/peers"))).toContain("kinds=MAIL");
  });

  it("still renders the list when a peer's account no longer resolves", async () => {
    // A departed colleague must not blank the inbox; the projected name on the
    // row is the fallback, which is exactly why `user` is nullable.
    const { body } = await run({ peers: TEN_PEERS, users: {} });

    expect(body.data.inboxPeers).toHaveLength(10);
    expect(body.data.inboxPeers[0].user).toBeNull();
    expect(body.data.inboxPeers[0].displayName).toBe("Peer1");
  });

  it("degrades to a partial result when auth-svc is down", async () => {
    // A screen missing one panel beats a screen that spins. The list survives;
    // the field that could not be resolved is null and reports why.
    const { body } = await run({ peers: TEN_PEERS, authStatus: 503 });

    expect(body.data.inboxPeers).toHaveLength(10);
    expect(body.data.inboxPeers[0].user).toBeNull();
    expect(body.errors?.[0]?.extensions?.service).toBe("auth-svc");
  });
});

describe("authentication", () => {
  it("refuses a request with no bearer token, before any upstream call", async () => {
    const { response, body, calls } = await run({ peers: [] }, { headers: {} });

    expect(response.status).toBe(401);
    expect(body.errors?.[0]?.message).toMatch(/bearer token is required/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed Authorization header", async () => {
    const { response } = await run({ peers: [] }, { headers: { authorization: "token-only" } });
    expect(response.status).toBe(401);
  });

  it("forwards the caller's own token upstream", async () => {
    const { fetchImpl } = stubServices({ peers: [] });
    const { yoga } = createGateway(testConfig(), { fetchImpl });

    await yoga.fetch("http://gw/graphql?operationName=InboxOverview", {
      headers: { authorization: "Bearer token-for-alice" },
    });

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token-for-alice");
  });
});

describe("trusted documents", () => {
  it("refuses an inline document", async () => {
    const { body } = await run(
      { peers: [] },
      { body: { query: "{ me { id email } }" }, headers: AUTHED },
    );
    expect(body.errors?.[0]?.message).toMatch(/only registered operations/);
    expect(body.data).toBeFalsy();
  });

  it("refuses an unregistered operation name", async () => {
    const { body } = await run({ peers: [] }, { search: "?operationName=DrainTheOrg" });
    expect(body.errors?.[0]?.message).toMatch(/unknown operation/);
  });

  it("refuses introspection", async () => {
    // Not reachable via the registry either, but asserted directly: the schema
    // is a map of the product's data access.
    const { body } = await run(
      { peers: [] },
      { body: { query: "{ __schema { types { name } } }" }, headers: AUTHED },
    );
    expect(body.errors?.[0]).toBeTruthy();
    expect(body.data?.__schema).toBeUndefined();
  });

  it("serves a registered operation over GET, so the URL is cacheable", async () => {
    const { response, body } = await run({ peers: [], users: {} });
    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
  });
});
