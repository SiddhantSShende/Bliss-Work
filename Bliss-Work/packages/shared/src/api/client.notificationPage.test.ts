/** notificationPage's `read` filter is a server-side query parameter: true / false
 *  when given, absent when not, alongside the cursor and limit. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

function urlSent() {
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return () => new URL(fetchMock.mock.calls[0]![0], "http://x").searchParams;
}
const client = () =>
  new ApiClient({ notificationBase: "http://notif.test", getToken: async () => "t" } as never);

afterEach(() => vi.unstubAllGlobals());

describe("notificationPage", () => {
  it("sends read=false for the unread feed, with limit and cursor", async () => {
    const params = urlSent();
    await client().notificationPage("cur-1", 10, false);
    expect(params().get("read")).toBe("false");
    expect(params().get("limit")).toBe("10");
    expect(params().get("cursor")).toBe("cur-1");
  });

  it("sends read=true for the read feed", async () => {
    const params = urlSent();
    await client().notificationPage(undefined, 10, true);
    expect(params().get("read")).toBe("true");
    expect(params().has("cursor")).toBe(false);
  });

  it("omits read entirely when no filter is given", async () => {
    const params = urlSent();
    await client().notificationPage(undefined, 10);
    expect(params().has("read")).toBe(false);
  });
});
