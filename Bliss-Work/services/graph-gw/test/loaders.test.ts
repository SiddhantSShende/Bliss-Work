/**
 * The DataLoader contract. Getting any of this wrong is how a gateway becomes
 * slower and less safe than the REST calls it replaced:
 *
 *   - batching  → one upstream call per operation, not per row (the whole point)
 *   - ordering  → results mapped by id, never by position (wrong name per row)
 *   - chunking  → a page bigger than the upstream's ceiling must still work
 *   - isolation → a loader must never outlive the request it was built for
 */
import { describe, expect, it, vi } from "vitest";
import { createLoaders, chunkIds, USER_BATCH_SIZE } from "../src/loaders.js";
import { Upstream } from "../src/upstream.js";
import { CALLER, jsonResponse, testConfig, U, userRow } from "./helpers.js";

/** Stub auth-svc: answers /auth/users?ids= with whatever it knows about. */
function stubAuth(known: Record<string, string>) {
  const calls: string[][] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const requested = new URL(String(url)).searchParams.get("ids")!.split(",");
    calls.push(requested);
    return jsonResponse(
      requested.filter((id) => known[id]).map((id) => userRow(id, known[id]!)),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function loadersWith(fetchImpl: typeof fetch) {
  const cfg = testConfig();
  return createLoaders(cfg, new Upstream(cfg, { fetchImpl }), CALLER);
}

describe("usersById", () => {
  it("collapses many loads in one tick into a single upstream call", async () => {
    const { fetchImpl, calls } = stubAuth({ [U(1)]: "Ada", [U(2)]: "Bo", [U(3)]: "Cy" });
    const loaders = loadersWith(fetchImpl);

    const users = await Promise.all([
      loaders.usersById.load(U(1)),
      loaders.usersById.load(U(2)),
      loaders.usersById.load(U(3)),
    ]);

    expect(calls).toHaveLength(1);
    expect(users.map((u) => u?.displayName)).toEqual(["Ada", "Bo", "Cy"]);
  });

  it("deduplicates repeated ids — twenty rows from one sender are one lookup", async () => {
    const { fetchImpl, calls } = stubAuth({ [U(1)]: "Ada" });
    const loaders = loadersWith(fetchImpl);

    await Promise.all(Array.from({ length: 20 }, () => loaders.usersById.load(U(1))));

    expect(calls).toEqual([[U(1)]]);
  });

  it("maps results by id, not by position", async () => {
    // The upstream sorts by username and omits ids it cannot resolve, so the
    // response order is NOT the request order. Mapping by position here would
    // print one colleague's e-mail under another's name.
    const fetchImpl = (async () =>
      jsonResponse([userRow(U(3), "Cy"), userRow(U(1), "Ada")])) as typeof fetch;
    const loaders = loadersWith(fetchImpl);

    const [first, second, third] = await Promise.all([
      loaders.usersById.load(U(1)),
      loaders.usersById.load(U(2)),
      loaders.usersById.load(U(3)),
    ]);

    expect(first?.displayName).toBe("Ada");
    expect(second).toBeNull(); // absent upstream
    expect(third?.displayName).toBe("Cy");
  });

  it("returns null for an unresolvable id rather than failing the query", async () => {
    // Ids come from message and task rows, which outlive the accounts they
    // reference. A departed colleague must not break the page they appear on.
    const { fetchImpl } = stubAuth({});
    await expect(loadersWith(fetchImpl).usersById.load(U(7))).resolves.toBeNull();
  });

  it("splits a batch larger than the upstream ceiling into whole chunks", async () => {
    const ids = Array.from({ length: USER_BATCH_SIZE + 5 }, (_, i) => U(i + 1));
    const known = Object.fromEntries(ids.map((id, i) => [id, `User${i}`]));
    const { fetchImpl, calls } = stubAuth(known);
    const loaders = loadersWith(fetchImpl);

    const users = await Promise.all(ids.map((id) => loaders.usersById.load(id)));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(USER_BATCH_SIZE); // auth-svc rejects more
    expect(calls[1]).toHaveLength(5);
    expect(users.every((u) => u !== null)).toBe(true);
  });

  it("caches within one request so a second load costs nothing", async () => {
    const { fetchImpl, calls } = stubAuth({ [U(1)]: "Ada" });
    const loaders = loadersWith(fetchImpl);

    await loaders.usersById.load(U(1));
    await loaders.usersById.load(U(1));

    expect(calls).toHaveLength(1);
  });

  it("gives each request its own cache, so one org's users cannot leak into another's", async () => {
    // The cache key is the user id alone — it carries no tenant. This is the
    // reason `createLoaders` is called per request and its result is never
    // hoisted; the test pins the behaviour that makes that safe.
    const { fetchImpl, calls } = stubAuth({ [U(1)]: "Ada" });

    await loadersWith(fetchImpl).usersById.load(U(1));
    await loadersWith(fetchImpl).usersById.load(U(1));

    expect(calls).toHaveLength(2); // no sharing between the two "requests"
  });

  it("rejects an upstream payload that is not a UserDTO", async () => {
    // Validate at the boundary: the resolvers type this as a UserDTO purely on
    // the strength of the parse.
    const fetchImpl = (async () => jsonResponse([{ id: U(1) }])) as typeof fetch;
    await expect(loadersWith(fetchImpl).usersById.load(U(1))).rejects.toBeTruthy();
  });
});

describe("chunkIds", () => {
  it("returns nothing for an empty list", () => {
    expect(chunkIds([], 3)).toEqual([]);
  });

  it("does not emit a trailing empty chunk when the size divides evenly", () => {
    expect(chunkIds(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a short final chunk", () => {
    expect(chunkIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});
