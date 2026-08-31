/**
 * Query.users(ids) — the ceiling on the resolver's own input.
 *
 * Unlike gateway.test.ts (which exercises resolvers through a real Yoga
 * instance and the persisted-operation allow-list), this calls the resolver
 * directly: the bug this file exists to catch is that the allow-list locks
 * the query DOCUMENT, never the VARIABLES a caller sends for a registered
 * operation, so `users(ids)` had no bound on `ids.length` at all — only on
 * how many ids each individual upstream call carried once a request was
 * already underway. A caller could put an arbitrarily large array in the
 * variables of any operation that takes it.
 */
import { GraphQLError } from "graphql";
import { describe, expect, it, vi } from "vitest";
import { createLoaders, MAX_USERS_QUERY_IDS } from "../src/loaders.js";
import { resolvers } from "../src/resolvers.js";
import { Upstream } from "../src/upstream.js";
import { CALLER, jsonResponse, testConfig, U, userRow } from "./helpers.js";

function contextWithMockUpstream() {
  const cfg = testConfig();
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const target = new URL(String(url));
    calls.push(`${target.pathname}${target.search}`);
    const ids = target.searchParams.get("ids")!.split(",");
    return jsonResponse(ids.map((id) => userRow(id, id)));
  }) as unknown as typeof fetch;

  const upstream = new Upstream(cfg, { fetchImpl });
  const loaders = createLoaders(cfg, upstream, CALLER);
  return { ctx: { cfg, upstream, caller: CALLER, loaders } as any, calls };
}

describe("Query.users — the ceiling on ids.length itself", () => {
  it(`refuses more than ${MAX_USERS_QUERY_IDS} ids, before any upstream call`, async () => {
    const { ctx, calls } = contextWithMockUpstream();
    const ids = Array.from({ length: MAX_USERS_QUERY_IDS + 1 }, (_, i) => U(i));

    await expect(resolvers.Query.users(null, { ids }, ctx)).rejects.toThrow(GraphQLError);
    // The whole point: rejecting must not cost even one upstream round trip —
    // that is what makes this a real bound rather than a bound that still
    // lets the fan-out happen before failing.
    expect(calls).toHaveLength(0);
  });

  it(`still serves exactly ${MAX_USERS_QUERY_IDS} ids`, async () => {
    const { ctx } = contextWithMockUpstream();
    const ids = Array.from({ length: MAX_USERS_QUERY_IDS }, (_, i) => U(i));

    const result = await resolvers.Query.users(null, { ids }, ctx);
    expect(result).toHaveLength(MAX_USERS_QUERY_IDS);
  });

  it("still batches a small request through the loader as before", async () => {
    const { ctx, calls } = contextWithMockUpstream();
    const ids = [U(1), U(2), U(3)];

    const result = await resolvers.Query.users(null, { ids }, ctx);
    expect(result).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });
});
