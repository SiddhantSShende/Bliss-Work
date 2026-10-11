/** directoryPage / channelsPage: the paged, searchable reads behind the pickers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const client = () =>
  new ApiClient({ authBase: "http://auth.test", messagingBase: "http://msg.test", getToken: async () => "tok" } as never);

const user = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, orgId: "00000000-0000-4000-8000-0000000000ff", orgName: "Acme", username: `u${n}`,
  displayName: `User ${n}`, email: `u${n}@acme.test`, roles: ["member"], avatarUrl: null,
  mfaEnrolled: false, orgRequireMfaForAdmins: false, orgMfaGracePeriodEndsAt: null, themePrefs: null,
});
const channel = (n: number, name: string) => ({
  id: `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`, name, memberCount: n, lastMessage: null, lastMessageAt: null,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("directoryPage", () => {
  it("sends q, limit and offset, url-encoded and trimmed, and nothing when none are given", async () => {
    const fetchStub = vi.fn(async (_url: string) => json([user(1)]));
    vi.stubGlobal("fetch", fetchStub);

    await client().directoryPage();
    await client().directoryPage({ q: "  ada & co  ", limit: 30, offset: 60 });
    await client().directoryPage({ q: "   ", limit: 30, offset: 0 });

    expect(fetchStub.mock.calls.map((c) => c[0])).toEqual([
      "http://auth.test/auth/directory",
      "http://auth.test/auth/directory?q=ada+%26+co&limit=30&offset=60",
      "http://auth.test/auth/directory?limit=30&offset=0", // a blank search is no search
    ]);
  });

  it("parses the rows with the real user schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([user(1), user(2)])));
    const rows = await client().directoryPage({ limit: 2 });
    expect(rows.map((u) => u.username)).toEqual(["u1", "u2"]);
  });
});

describe("channelsPage", () => {
  it("asks /channels/mine with q, limit and offset", async () => {
    const fetchStub = vi.fn(async (_url: string) => json([channel(1, "general")]));
    vi.stubGlobal("fetch", fetchStub);

    const rows = await client().channelsPage({ q: "gen", limit: 30, offset: 30 });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]![0]).toBe("http://msg.test/api/v1/channels/mine?q=gen&limit=30&offset=30");
    expect(rows.map((c) => c.name)).toEqual(["general"]);
  });

  describe("against a messaging-svc that predates /channels/mine", () => {
    const all = [channel(3, "Zeta"), channel(1, "alpha"), channel(2, "Beta"), channel(4, "alphabet")];
    const stub = (status: number) => {
      const fetchStub = vi.fn(async (url: string) =>
        url.includes("/channels/mine") ? json({ error: "not found" }, status) : json(all),
      );
      vi.stubGlobal("fetch", fetchStub);
      return fetchStub;
    };

    it.each([404, 405])("falls back to the whole list on %i, filtered, name-ordered and sliced here", async (status) => {
      const fetchStub = stub(status);
      const first = await client().channelsPage({ limit: 2, offset: 0 });
      expect(first.map((c) => c.name)).toEqual(["alpha", "alphabet"]);
      const second = await client().channelsPage({ limit: 2, offset: 2 });
      expect(second.map((c) => c.name)).toEqual(["Beta", "Zeta"]);
      const search = await client().channelsPage({ q: "ALPHA", limit: 10, offset: 0 });
      expect(search.map((c) => c.name)).toEqual(["alpha", "alphabet"]);
      expect(fetchStub.mock.calls.some((c) => String(c[0]).endsWith("/api/v1/channels"))).toBe(true);
    });

    it("does not mask a real failure: a 500 still throws", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
      await expect(client().channelsPage({ limit: 5 })).rejects.toMatchObject({ status: 500 });
    });
  });
});
