/**
 * Ids are spliced into request paths, and some come from the address bar
 * (`/call/:callId`). A crafted one must not be able to redirect the request to a
 * different endpoint on the same origin; valid ids must produce exactly the URL
 * they always did.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const CALL = "11111111-1111-4111-8111-111111111111";
const client = () =>
  new ApiClient({ authBase: "http://auth.test", messagingBase: "http://msg.test", getToken: async () => "tok" } as never);

const fetchStub = () =>
  vi.fn(async (_url: string) => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());

describe("request path safety", () => {
  it("leaves a valid id's URL exactly as before", async () => {
    const f = fetchStub();
    vi.stubGlobal("fetch", f);
    await client().removeMember(CALL).catch(() => undefined);
    expect(f.mock.calls[0]![0]).toBe(`http://auth.test/auth/members/${CALL}`);
  });

  it.each(["..", ".", "%2e%2e", "%2E%2E", ".%2e", "%2e.", "../../auth/members"])(
    "refuses a dot-segment id %j before anything is sent",
    async (id) => {
      const f = fetchStub();
      vi.stubGlobal("fetch", f);
      const err = await client().removeMember(id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 400 });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it("refuses a backslash-separated traversal, which the URL parser reads as '/'", async () => {
    const f = fetchStub();
    vi.stubGlobal("fetch", f);
    const err = await client().removeMember("x\\..\\y").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it("does not mistake dots inside a name or a query string for traversal", async () => {
    const f = fetchStub();
    vi.stubGlobal("fetch", f);
    await client().removeMember("a..b").catch(() => undefined);
    expect(f).toHaveBeenCalledTimes(1);
    await client().inboxPeers(["TASK" as never]).catch(() => undefined);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
