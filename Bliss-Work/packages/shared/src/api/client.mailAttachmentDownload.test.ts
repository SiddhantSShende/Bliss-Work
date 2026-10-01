/**
 * recordMailAttachmentDownload: the one call behind a mail attachment's explicit
 * Download. It must be a body-less authenticated POST to the mail's own path —
 * the server takes the acting user from the token, so nothing here may name one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const MAIL = "11111111-1111-4111-8111-111111111111";
const ATT = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllGlobals());

describe("recordMailAttachmentDownload", () => {
  it("POSTs to the mail's attachment path with the bearer token and no body", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchStub);
    const client = new ApiClient({ messagingBase: "http://msg.test", getToken: async () => "tok" } as never);

    await expect(client.recordMailAttachmentDownload(MAIL, ATT)).resolves.toBeUndefined();

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://msg.test/api/v1/mail/${MAIL}/attachments/${ATT}/downloaded`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("rejects when the server refuses (the hook swallows that, the client does not)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "no" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })),
    );
    const client = new ApiClient({ messagingBase: "http://msg.test", getToken: async () => "tok" } as never);

    await expect(client.recordMailAttachmentDownload(MAIL, ATT)).rejects.toBeDefined();
  });
});
