import { describe, expect, it } from "vitest";
import { parseRefreshCookie, refreshTokenFromSetCookie } from "./refresh-cookie";

describe("parseRefreshCookie", () => {
  it("extracts the value from a full Set-Cookie line", () => {
    expect(parseRefreshCookie("refresh_token=abc123; Path=/; HttpOnly; SameSite=Lax")).toBe("abc123");
  });

  it("returns an empty string for the logout cookie (cleared value)", () => {
    expect(parseRefreshCookie("refresh_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")).toBe("");
  });

  it("returns null for an unrelated cookie", () => {
    expect(parseRefreshCookie("session_id=xyz; Path=/")).toBeNull();
  });

  it("does not match a cookie name that merely contains refresh_token as a substring", () => {
    expect(parseRefreshCookie("my_refresh_token=stolen; Path=/")).toBeNull();
    expect(parseRefreshCookie("xrefresh_token=stolen; Path=/")).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(parseRefreshCookie("refresh_token=a%2Fb%3Dc; Path=/")).toBe("a/b=c");
  });

  it("falls back to the raw value on a malformed percent-escape", () => {
    expect(parseRefreshCookie("refresh_token=a%; Path=/")).toBe("a%");
  });
});

describe("refreshTokenFromSetCookie", () => {
  it("returns undefined when there is no Set-Cookie header at all", () => {
    expect(refreshTokenFromSetCookie(undefined)).toBeUndefined();
  });

  it("returns undefined when no line mentions the refresh token (leave the mirror alone)", () => {
    expect(refreshTokenFromSetCookie(["session_id=xyz; Path=/"])).toBeUndefined();
  });

  it("returns the token from a single matching line", () => {
    expect(refreshTokenFromSetCookie(["refresh_token=new-token; Path=/; HttpOnly"])).toBe("new-token");
  });

  it("the last line mentioning the cookie wins, matching browser cookie-jar order", () => {
    expect(
      refreshTokenFromSetCookie([
        "refresh_token=first; Path=/",
        "session_id=xyz; Path=/",
        "refresh_token=second; Path=/",
      ]),
    ).toBe("second");
  });

  it("returns null for the clearing cookie, distinct from undefined", () => {
    expect(refreshTokenFromSetCookie(["refresh_token=; Path=/; Max-Age=0"])).toBeNull();
  });

  it("an unrelated line after the token does not erase the value already found", () => {
    expect(
      refreshTokenFromSetCookie(["refresh_token=keep-me; Path=/", "session_id=xyz; Path=/"]),
    ).toBe("keep-me");
  });
});
