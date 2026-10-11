/** GET /auth/captcha: a refresh names the challenge it replaces. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const client = () => new ApiClient({ authBase: "http://auth.test", getToken: async () => "tok" } as never);
const CHALLENGE = { captchaId: "cap-2", captchaImage: "data:image/png;base64,AAAA", expiresIn: 300 };

const stubFetch = () => {
  const fetchStub = vi.fn(
    async (_url: string) =>
      new Response(JSON.stringify(CHALLENGE), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

afterEach(() => vi.unstubAllGlobals());

describe("getCaptcha", () => {
  it("asks for a challenge with no query the first time", async () => {
    const fetchStub = stubFetch();
    await expect(client().getCaptcha()).resolves.toMatchObject({ captchaId: "cap-2" });
    expect(fetchStub.mock.calls[0]![0]).toBe("http://auth.test/auth/captcha");
  });

  it("names the challenge being replaced, url-encoded", async () => {
    const fetchStub = stubFetch();
    await client().getCaptcha("cap-1");
    expect(fetchStub.mock.calls[0]![0]).toBe("http://auth.test/auth/captcha?replaces=cap-1");

    await client().getCaptcha("a b&c");
    expect(fetchStub.mock.calls[1]![0]).toBe("http://auth.test/auth/captcha?replaces=a%20b%26c");
  });
});
