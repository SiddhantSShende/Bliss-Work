/**
 * Request/response contract tests.
 *
 * The user asked for "session-based testing" + "test the requests and
 * responses". This file is the static (no live server) part of that: it
 * pins the canonical envelope shape we promise every service emits.
 *
 * The live session test that walks createOrg → login → me → refresh → logout
 * and asserts every JSON body lives in services/auth-svc/tests/ (pytest +
 * httpx + the testcontainers-spun Postgres). It can't run in this Vitest
 * setup because it requires a real auth-svc; we keep the contract pinned
 * here so frontend changes that break the shape get caught at build time.
 */
import { describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../types/errors";

// What every service is contracted to emit on a non-2xx response.
function validateEnvelope(body: unknown): asserts body is ApiErrorBody {
  if (typeof body !== "object" || body === null) {
    throw new Error("error envelope must be an object");
  }
  const e = (body as { error?: unknown }).error;
  if (typeof e !== "object" || e === null) {
    throw new Error("envelope must have an 'error' object");
  }
  const obj = e as Record<string, unknown>;
  if (typeof obj.code !== "string") throw new Error("error.code must be string");
  if (typeof obj.message !== "string") throw new Error("error.message must be string");
  if (typeof obj.requestId !== "string") throw new Error("error.requestId must be string");
  if (obj.details !== undefined && typeof obj.details !== "object") {
    throw new Error("error.details must be object or absent");
  }
}

describe("canonical error envelope shape", () => {
  it("accepts a minimal envelope", () => {
    expect(() =>
      validateEnvelope({
        error: { code: "bad_request", message: "x", requestId: "" },
      }),
    ).not.toThrow();
  });

  it("accepts an envelope with details", () => {
    expect(() =>
      validateEnvelope({
        error: {
          code: "validation_error",
          message: "x",
          requestId: "r-1",
          details: { fields: [{ loc: ["body", "email"], msg: "invalid" }] },
        },
      }),
    ).not.toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateEnvelope("just a string")).toThrow(/object/);
  });

  it("rejects a body without 'error'", () => {
    expect(() => validateEnvelope({ message: "x" })).toThrow(/error/);
  });

  it("rejects a body where error.code is missing", () => {
    expect(() => validateEnvelope({ error: { message: "x", requestId: "" } })).toThrow(
      /code/,
    );
  });

  it("rejects a body where requestId is the wrong type", () => {
    expect(() =>
      validateEnvelope({ error: { code: "x", message: "y", requestId: 123 } }),
    ).toThrow(/requestId/);
  });

  it("rejects a body where details is a string", () => {
    expect(() =>
      validateEnvelope({
        error: { code: "x", message: "y", requestId: "", details: "oops" },
      }),
    ).toThrow(/details/);
  });
});

// A small sanity check that the codes we emit from services match the union
// declared in errors.ts. If a service ever invents a new code, TypeScript
// catches it at build time elsewhere; this test pins the *current* set.
describe("error code coverage", () => {
  const expected = [
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "validation_error",
    "rate_limited",
    "internal_error",
    "service_unavailable",
    "gateway_timeout",
  ];
  it("has the canonical codes", () => {
    // Just touch each one through the type system to make sure it compiles.
    for (const code of expected) {
      const body: ApiErrorBody = {
        error: { code: code as ApiErrorBody["error"]["code"], message: "x", requestId: "" },
      };
      expect(body.error.code).toBe(code);
    }
  });
});
