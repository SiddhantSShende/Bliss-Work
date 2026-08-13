/**
 * The extension's exclusion rules.
 *
 * These are the tests that matter most in the whole feature. Everything else
 * either fails loudly or produces a wrong number; a regression here quietly
 * writes somebody's visit to a hospital, a bank or a job site into a record
 * their employer reads. The rules are enforced in one pure function precisely so
 * they can be pinned here.
 */
import { describe, expect, it } from "vitest";
import { registrableDomain, stripQuery, toAgentEvent, toVisit } from "./tracker";

const T0 = Date.parse("2026-08-13T09:00:00.000Z");
const LONG = 60_000;

const visit = (url: string, opts: { incognito?: boolean; ms?: number; blocked?: string[] } = {}) =>
  toVisit({ url, incognito: opts.incognito }, T0, opts.ms ?? LONG, opts.blocked ?? []);

describe("what may be recorded", () => {
  it("records an ordinary work site", () => {
    const v = visit("https://github.com/acme/repo/pull/42");
    expect(v).not.toBeNull();
    expect(v!.domain).toBe("github.com");
    expect(v!.path).toBe("/acme/repo/pull/42");
  });

  it("NEVER records incognito windows", () => {
    // The person has explicitly said this is not to be recorded. The extension
    // can technically see it; that is exactly why this test exists.
    expect(visit("https://github.com/acme", { incognito: true })).toBeNull();
  });

  it("NEVER records health sites", () => {
    expect(visit("https://www.nhs.uk/conditions/something")).toBeNull();
    expect(visit("https://www.mayoclinic.org/diseases")).toBeNull();
  });

  it("NEVER records banking or finance", () => {
    expect(visit("https://www.paypal.com/myaccount")).toBeNull();
    expect(visit("https://www.coinbase.com/portfolio")).toBeNull();
  });

  it("NEVER records government or support services", () => {
    expect(visit("https://www.gov.uk/universal-credit")).toBeNull();
    expect(visit("https://www.samaritans.org/how-we-can-help/")).toBeNull();
  });

  it("NEVER records job hunting", () => {
    // Recording this turns a monitoring tool into a retaliation tool.
    expect(visit("https://www.indeed.com/jobs?q=engineer")).toBeNull();
    expect(visit("https://www.linkedin.com/jobs/view/123")).toBeNull();
  });

  it("still records the non-jobs part of a partly-blocked site", () => {
    // The blocklist matches host+path, so linkedin.com/feed is fine while
    // linkedin.com/jobs is not — a blunt whole-domain block would be both
    // over- and under-inclusive.
    expect(visit("https://www.linkedin.com/feed/")).not.toBeNull();
  });

  it("honours an organisation's additional blocklist", () => {
    expect(visit("https://internal-hr.example.com/cases", { blocked: ["internal-hr"] })).toBeNull();
  });

  it("returns null rather than a redacted placeholder", () => {
    // "visited [redacted] for 40 minutes" is still a disclosure that they were
    // somewhere they did not want recorded.
    expect(visit("https://www.nhs.uk/x")).toBeNull();
  });
});

describe("what is stripped", () => {
  it("drops the query string", () => {
    // Search terms, session tokens and password-reset links all live here.
    const v = visit("https://example.com/search?q=how+to+resign&token=abc123");
    expect(v!.path).toBe("/search");
    expect(JSON.stringify(v)).not.toContain("resign");
    expect(JSON.stringify(v)).not.toContain("abc123");
  });

  it("drops the fragment", () => {
    const v = visit("https://example.com/doc#section-4");
    expect(v!.path).toBe("/doc");
  });

  it("bounds a pathological path", () => {
    const v = visit(`https://example.com/${"a".repeat(5000)}`);
    expect(v!.path.length).toBeLessThanOrEqual(200);
  });

  it("keeps the query out of the wire payload too", () => {
    const v = visit("https://example.com/x?secret=1")!;
    expect(JSON.stringify(toAgentEvent(v))).not.toContain("secret");
  });
});

describe("what is not a visit at all", () => {
  it("ignores browser-internal pages", () => {
    expect(visit("chrome://settings")).toBeNull();
    expect(visit("about:blank")).toBeNull();
    expect(visit("chrome-extension://abc/options.html")).toBeNull();
  });

  it("ignores local files", () => {
    expect(visit("file:///home/someone/tax-return.pdf")).toBeNull();
  });

  it("ignores intranet hostnames with no dot", () => {
    expect(visit("http://localhost:5173/app")).toBeNull();
    expect(visit("http://wiki/page")).toBeNull();
  });

  it("ignores malformed urls", () => {
    expect(visit("not a url")).toBeNull();
  });

  it("ignores spans too short to mean anything", () => {
    // A redirect hop or a tab passed through with alt-tab.
    expect(visit("https://example.com/", { ms: 2_000 })).toBeNull();
    expect(visit("https://example.com/", { ms: 6_000 })).not.toBeNull();
  });
});

describe("registrableDomain", () => {
  it("strips subdomains and www", () => {
    expect(registrableDomain("www.github.com")).toBe("github.com");
    expect(registrableDomain("api.staging.github.com")).toBe("github.com");
  });

  it("handles common two-part suffixes", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
  });

  it("is case-insensitive", () => {
    expect(registrableDomain("WWW.GitHub.COM")).toBe("github.com");
  });

  it("leaves a bare domain alone", () => {
    expect(registrableDomain("example.com")).toBe("example.com");
  });
});

describe("the wire shape", () => {
  it("puts the aggregatable domain in the clear and the path in detail", () => {
    // targetId is plaintext because every rollup groups by it; the revealing
    // half goes in `detail`, which the server encrypts per-org.
    const e = toAgentEvent(visit("https://github.com/acme/secret-repo")!);
    expect(e.targetId).toBe("github.com");
    expect(e.category).toBe("site");
    expect(e.detail.url).toBe("github.com/acme/secret-repo");
    expect(e.durationMs).toBe(LONG);
  });

  it("stamps the START of the span, not the end", () => {
    const e = toAgentEvent(visit("https://example.com/")!);
    expect(e.occurredAt).toBe(new Date(T0).toISOString());
  });
});

describe("stripQuery", () => {
  it("defaults a bare origin to /", () => {
    expect(stripQuery(new URL("https://example.com"))).toBe("/");
  });
});
