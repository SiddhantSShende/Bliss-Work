import { describe, expect, it } from "vitest";
import { parseRefreshCookie, refreshTokenFromSetCookie } from "./refresh-cookie";

/**
 * These cover the desktop's ONLY reliable source of the rotated refresh token.
 * Getting this wrong does not look like a parse bug — it looks like "the app
 * signs me out every time I reload", because a stale token trips the server's
 * reuse detection and revokes the whole family.
 */

describe("parseRefreshCookie", () => {
  it("reads the token off a normal Set-Cookie line", () => {
    expect(
      parseRefreshCookie("refresh_token=abc123; Path=/; HttpOnly; SameSite=Lax; Secure"),
    ).toBe("abc123");
  });

  it("ignores lines about other cookies", () => {
    expect(parseRefreshCookie("session_id=zzz; Path=/")).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    // Without a boundary anchor this would match and mirror another app's value.
    expect(parseRefreshCookie("my_refresh_token=nope; Path=/")).toBeNull();
  });

  it("finds the cookie when it is not first on the line", () => {
    expect(parseRefreshCookie("foo=1; refresh_token=abc; Path=/")).toBe("abc");
  });

  it("reports the logout cookie as an empty value, not as absent", () => {
    // "" and null mean different things: clear the mirror vs leave it alone.
    expect(parseRefreshCookie("refresh_token=; Path=/; Max-Age=0")).toBe("");
  });

  it("percent-decodes the value", () => {
    expect(parseRefreshCookie("refresh_token=a%2Bb; Path=/")).toBe("a+b");
  });

  it("keeps a malformed escape verbatim rather than dropping the token", () => {
    expect(parseRefreshCookie("refresh_token=100%; Path=/")).toBe("100%");
  });
});

describe("refreshTokenFromSetCookie", () => {
  it("says nothing when there is no header at all", () => {
    expect(refreshTokenFromSetCookie(undefined)).toBeUndefined();
  });

  it("says nothing when no line mentions the refresh token", () => {
    // undefined, NOT null — a response that never mentions the cookie must not
    // clear a perfectly good stored token.
    expect(refreshTokenFromSetCookie(["a=1; Path=/", "b=2; Path=/"])).toBeUndefined();
  });

  it("picks the token out of a multi-cookie header", () => {
    expect(
      refreshTokenFromSetCookie([
        "csrf=xyz; Path=/",
        "refresh_token=tok-1; Path=/; HttpOnly",
      ]),
    ).toBe("tok-1");
  });

  it("clears on the logout cookie", () => {
    expect(refreshTokenFromSetCookie(["refresh_token=; Max-Age=0; Path=/"])).toBeNull();
  });

  it("lets the last line win, as a browser would", () => {
    expect(
      refreshTokenFromSetCookie(["refresh_token=old; Path=/", "refresh_token=new; Path=/"]),
    ).toBe("new");
  });
});
