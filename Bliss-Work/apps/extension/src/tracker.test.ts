/**
 * The extension's capture rules, in both configurations.
 *
 * This deployment DEFAULTS to capturing everything: the full URL including the
 * query string, every site category, and private windows. The safety floor
 * (NEVER_RECORD, incognito-skip) is retained as a switch so a workspace can be
 * dialled back for a jurisdiction without reshipping — so it is tested in both
 * states. `toVisit` is a pure function precisely so these rules can be pinned
 * here rather than only exercised inside a service worker that is constantly
 * killed and restarted.
 */
import { describe, expect, it } from "vitest";
import { fullPath, registrableDomain, toAgentEvent, toVisit, type CaptureConfig } from "./tracker";

const T0 = Date.parse("2026-08-13T09:00:00.000Z");
const LONG = 60_000;

// Default deployment config: capture everything.
const ALL: CaptureConfig = { captureAll: true, captureIncognito: true };
// The dial-back mode: the safety floor and incognito-skip switched back on.
const FLOOR: CaptureConfig = { captureAll: false, captureIncognito: false };

const visit = (url: string, opts: { incognito?: boolean; ms?: number } = {}, cfg: CaptureConfig = ALL) =>
  toVisit({ url, incognito: opts.incognito }, T0, opts.ms ?? LONG, cfg);

describe("the SHIPPED default is the protected floor", () => {
  // toVisit's default opts = {} → captureAll/captureIncognito falsy → floor on,
  // incognito skipped. This is what a browser records out of the box; going
  // aggressive requires an explicit per-device flag (see background.captureOpts),
  // which no managed policy can set.
  it("applies the sensitive-category floor with no config", () => {
    expect(toVisit({ url: "https://www.nhs.uk/conditions/x" }, T0, LONG)).toBeNull();
    expect(toVisit({ url: "https://www.paypal.com/myaccount" }, T0, LONG)).toBeNull();
    expect(toVisit({ url: "https://www.indeed.com/jobs?q=x" }, T0, LONG)).toBeNull();
  });
  it("skips incognito with no config", () => {
    expect(toVisit({ url: "https://example.com/x", incognito: true }, T0, LONG)).toBeNull();
  });
  it("still records an ordinary site — with its full url — by default", () => {
    expect(toVisit({ url: "https://github.com/a/b?tab=files" }, T0, LONG)!.path).toBe("/a/b?tab=files");
  });
});

describe("aggressive mode when a device explicitly opts in", () => {
  it('records the FULL url including the query string (the "what did they do")', () => {
    const v = visit("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s");
    expect(v).not.toBeNull();
    expect(v!.domain).toBe("youtube.com");
    // The video id and timestamp — the actual thing they watched — are kept.
    expect(v!.path).toBe("/watch?v=dQw4w9WgXcQ&t=42s");
  });

  it("records a search including its terms", () => {
    const v = visit("https://www.google.com/search?q=how+to+quit+my+job");
    expect(v!.path).toBe("/search?q=how+to+quit+my+job");
  });

  it("keeps the fragment", () => {
    expect(visit("https://example.com/doc#section-4")!.path).toBe("/doc#section-4");
  });

  it("records categories the safety floor would exclude", () => {
    // With captureAll on there is no floor: health, finance, gov, jobs all land.
    expect(visit("https://www.nhs.uk/conditions/x")).not.toBeNull();
    expect(visit("https://www.paypal.com/myaccount")).not.toBeNull();
    expect(visit("https://www.indeed.com/jobs?q=engineer")).not.toBeNull();
  });

  it("records incognito windows when configured to", () => {
    expect(visit("https://example.com/x", { incognito: true })).not.toBeNull();
  });

  it("bounds a pathological url", () => {
    const v = visit(`https://example.com/?q=${"a".repeat(5000)}`);
    expect(v!.path.length).toBeLessThanOrEqual(512);
  });
});

describe("dial-back mode — the retained safety floor", () => {
  it("skips incognito again", () => {
    expect(visit("https://example.com/x", { incognito: true }, FLOOR)).toBeNull();
  });

  it("re-applies the sensitive-category floor", () => {
    expect(visit("https://www.nhs.uk/conditions/x", {}, FLOOR)).toBeNull();
    expect(visit("https://www.paypal.com/myaccount", {}, FLOOR)).toBeNull();
    expect(visit("https://www.indeed.com/jobs?q=x", {}, FLOOR)).toBeNull();
  });

  it("still records ordinary sites — with the full url", () => {
    // The floor is about WHICH sites, not how much of the url; an allowed site
    // still records its query in dial-back mode.
    const v = visit("https://github.com/acme/repo/pull/42?tab=files", {}, FLOOR);
    expect(v!.path).toBe("/acme/repo/pull/42?tab=files");
  });
});

describe("an org's own blocklist is always honoured", () => {
  it("applies extraBlocked even when capturing everything", () => {
    const cfg: CaptureConfig = { captureAll: true, captureIncognito: true, extraBlocked: ["internal-hr"] };
    expect(toVisit({ url: "https://internal-hr.example.com/cases" }, T0, LONG, cfg)).toBeNull();
  });
});

describe("what is not a visit at all", () => {
  it("ignores browser-internal pages", () => {
    expect(visit("chrome://settings")).toBeNull();
    expect(visit("about:blank")).toBeNull();
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
});

describe("the wire shape", () => {
  it("puts the domain in the clear and the full url in encrypted detail", () => {
    // targetId is plaintext because every rollup groups by it; the revealing
    // half — now the full url with query — goes in `detail`, which the server
    // encrypts per-org and reads one row at a time, never aggregated.
    const e = toAgentEvent(visit("https://www.youtube.com/watch?v=abc123")!);
    expect(e.targetId).toBe("youtube.com");
    expect(e.category).toBe("site");
    expect(e.detail.url).toBe("youtube.com/watch?v=abc123");
    expect(e.durationMs).toBe(LONG);
  });
  it("stamps the START of the span, not the end", () => {
    expect(toAgentEvent(visit("https://example.com/")!).occurredAt).toBe(new Date(T0).toISOString());
  });
});

describe("fullPath", () => {
  it("defaults a bare origin to /", () => {
    expect(fullPath(new URL("https://example.com"))).toBe("/");
  });
  it("keeps path, query and fragment", () => {
    expect(fullPath(new URL("https://x.com/a/b?c=1&d=2#e"))).toBe("/a/b?c=1&d=2#e");
  });
});
