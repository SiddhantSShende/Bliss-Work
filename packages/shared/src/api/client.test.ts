/**
 * Tests for ApiError.fromResponse — the single chokepoint where every
 * non-2xx response from every service is turned into a typed Error the
 * frontend can render. If this regresses, the UI loses requestId support
 * silently. Pin the parse cases here.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";

// A minimal Response stand-in. The web Response has Streams and locks we
// don't need; vitest runs in node by default and the global Response may
// behave subtly differently. Using a hand-rolled stub keeps the test pure.
function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    } as Response["headers"],
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("ApiError.fromResponse", () => {
  it("parses the canonical envelope", async () => {
    const body = JSON.stringify({
      error: {
        code: "rate_limited",
        message: "slow down",
        requestId: "req-123",
        details: { retryAfter: 60 },
      },
    });
    const err = await ApiError.fromResponse(fakeResponse(429, body));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toBe("slow down");
    expect(err.requestId).toBe("req-123");
    expect(err.details).toEqual({ retryAfter: 60 });
  });

  it("prefers requestId from the body over the header (services match them anyway)", async () => {
    const body = JSON.stringify({
      error: { code: "bad_request", message: "no", requestId: "from-body" },
    });
    const err = await ApiError.fromResponse(
      fakeResponse(400, body, { "x-request-id": "from-header" }),
    );
    expect(err.requestId).toBe("from-body");
  });

  it("falls back to the response header when the body doesn't carry one", async () => {
    const err = await ApiError.fromResponse(
      fakeResponse(500, "not json at all", { "x-request-id": "hdr-only" }),
    );
    expect(err.requestId).toBe("hdr-only");
    expect(err.status).toBe(500);
    expect(err.code).toBe("internal_error"); // derived from status
  });

  it("survives an empty body", async () => {
    const err = await ApiError.fromResponse(fakeResponse(503, ""));
    expect(err.status).toBe(503);
    // 503 has no specific mapping in httpStatusToCode → falls to internal_error.
    expect(err.code).toBe("internal_error");
  });

  it("survives a body that isn't JSON", async () => {
    const err = await ApiError.fromResponse(
      fakeResponse(502, "<html>nginx</html>", { "x-request-id": "gw-trace" }),
    );
    expect(err.requestId).toBe("gw-trace");
    expect(err.message).toBe("<html>nginx</html>");
  });

  it("defaults message to statusText when both body and header are empty", async () => {
    const r = fakeResponse(404, "");
    (r as { statusText: string }).statusText = "Not Found";
    const err = await ApiError.fromResponse(r);
    expect(err.message).toBe("Not Found");
    expect(err.code).toBe("not_found");
  });
});

describe("ApiError instance fields", () => {
  it("derives code from status when no opts supplied", () => {
    const err = new ApiError(401, "nope");
    expect(err.code).toBe("unauthorized");
    expect(err.requestId).toBe("");
    expect(err.details).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
  });

  it("honours opts when supplied", () => {
    const err = new ApiError(409, "dup", {
      code: "conflict",
      requestId: "r-1",
      details: { field: "email" },
    });
    expect(err.code).toBe("conflict");
    expect(err.requestId).toBe("r-1");
    expect(err.details).toEqual({ field: "email" });
  });
});
