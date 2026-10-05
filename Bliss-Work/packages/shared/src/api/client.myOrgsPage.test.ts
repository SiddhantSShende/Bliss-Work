/** myOrgsPage must work against both a paging auth-svc ({items, hasMore}) and one
 *  that predates paging and answers /auth/orgs/mine with the whole list. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const org = (n: number, name = `Org ${n}`) => ({
  orgId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  orgName: name,
  roles: ["member"],
  active: n === 1,
});

function respondWith(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const client = () => new ApiClient({ authBase: "http://auth.test", getToken: async () => "t" } as never);

afterEach(() => vi.unstubAllGlobals());

describe("myOrgsPage", () => {
  it("sends search, offset and limit and returns a paged reply untouched", async () => {
    const fetchMock = respondWith({ items: [org(1), org(2)], hasMore: true });
    const page = await client().myOrgsPage({ search: "o", offset: 0, limit: 2 });
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe("/auth/orgs/mine");
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "o", offset: "0", limit: "2" });
    expect(page).toEqual({ items: [org(1), org(2)], hasMore: true });
  });

  it("pages a plain-list reply from an auth-svc that predates paging", async () => {
    respondWith([org(3), org(1), org(2)]);
    const first = await client().myOrgsPage({ search: "", offset: 0, limit: 2 });
    expect(first.items.map((o) => o.orgName)).toEqual(["Org 1", "Org 2"]);
    expect(first.hasMore).toBe(true);
    const second = await client().myOrgsPage({ search: "", offset: 2, limit: 2 });
    expect(second.items.map((o) => o.orgName)).toEqual(["Org 3"]);
    expect(second.hasMore).toBe(false);
  });

  it("applies a case-insensitive name search to a plain-list reply", async () => {
    respondWith([org(1, "Acme"), org(2, "Globex"), org(3, "ACME Labs")]);
    const page = await client().myOrgsPage({ search: "acme", offset: 0, limit: 10 });
    expect(page.items.map((o) => o.orgName)).toEqual(["Acme", "ACME Labs"]);
    expect(page.hasMore).toBe(false);
  });

  it("still rejects a body that is neither shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith({ nope: true });
    await expect(client().myOrgsPage({ search: "", offset: 0, limit: 2 })).rejects.toMatchObject({ status: 502 });
  });
});
