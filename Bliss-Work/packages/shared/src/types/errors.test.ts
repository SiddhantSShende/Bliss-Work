import { describe, expect, it } from "vitest";
import { httpStatusToCode } from "./errors";

describe("httpStatusToCode", () => {
  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "validation_error"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [502, "internal_error"],
    [503, "internal_error"],
    [504, "gateway_timeout"],
  ])("status %d -> code %s", (status, code) => {
    expect(httpStatusToCode(status)).toBe(code);
  });

  it("unknown 4xx falls back to bad_request", () => {
    expect(httpStatusToCode(418)).toBe("bad_request");
  });

  it("any 5xx without specific mapping falls back to internal_error", () => {
    expect(httpStatusToCode(599)).toBe("internal_error");
  });
});
