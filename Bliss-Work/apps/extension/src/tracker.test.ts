/**
 * The extension's capture rules, in both configurations.
 *
 * The SHIPPED default is the protected floor: an absent/undefined config —
 * what `toVisit` gets with no `chrome.storage.local` flags set — applies
 * NEVER_RECORD and skips incognito (see `background.ts`'s `captureOpts`,
 * which reads `captureAll`/`captureIncognito` with `=== true`, so unset means
 * off). A device can be switched to capture-everything explicitly and
 * per-device (never via managed policy — see `managed-schema.json`'s own
 * comment on why), which is the OTHER configuration this file tests. `toVisit`
 * is a pure function precisely so both configurations can be pinned here
 * rather than only exercised inside a service worker that is constantly
 * killed and restarted.
 */
import { describe, expect, it } from "vitest";
import { fullPath, registrableDomain, toAgentEvent, toVisit, type CaptureConfig } from "./tracker";

const T0 = Date.parse("2026-08-13T09:00:00.000Z");
const LONG = 60_000;

// The explicit opt-in: a device switched to capture everything.
const ALL: CaptureConfig = { captureAll: true, captureIncognito: true };
// The SHIPPED default, spelled out explicitly here for the tests below that
// want it named — `toVisit`'s own default opts ({}) already behaves this way.
const FLOOR: CaptureConfig = { captureAll: false, captureIncognito: false };

const visit = (
  url: string,
  opts: { incognito?: boolean; ms?: number; title?: string } = {},
  cfg: CaptureConfig = ALL,
) => toVisit({ url, incognito: opts.incognito, title: opts.title }, T0, opts.ms ?? LONG, cfg);

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
  it("mirrors the domain into detail alongside targetId — the ActivityDetail contract", () => {
    expect(toAgentEvent(visit("https://github.com/a/b")!).detail.domain).toBe("github.com");
  });

  it("stamps a fresh clientEventId on every call — the migration 0006 idempotency key", () => {
    // toAgentEvent is called once, here, when the span is first queued — never
    // again for that same Visit (background.ts's enqueue()/flush() only ever
    // re-send the object already sitting in chrome.storage.session). A second
    // call therefore represents a DIFFERENT visit, not a retry of this one, and
    // must get its own id — the property migration 0006's dedup depends on:
    // two real visits must never collide, only a genuine re-send of the exact
    // same queued object may.
    const v = visit("https://github.com/a/b")!;
    const first = toAgentEvent(v).clientEventId;
    const second = toAgentEvent(v).clientEventId;
    expect(first).not.toBe(second);
    // A real UUID, not a placeholder string — the server's dedup index is
    // keyed on this value being stable and unique, not merely present.
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("page title", () => {
  it("is carried in detail when the tab reported one", () => {
    const v = visit("https://example.com/x", { title: "Some Page" });
    expect(v!.title).toBe("Some Page");
    expect(toAgentEvent(v!).detail.title).toBe("Some Page");
  });

  it("is absent from detail when the tab had none — not a required field", () => {
    const v = visit("https://example.com/x");
    expect(v!.title).toBeUndefined();
    expect(toAgentEvent(v!).detail.title).toBeUndefined();
  });

  it("trims a title and treats whitespace-only as absent", () => {
    expect(visit("https://example.com/x", { title: "  Padded  " })!.title).toBe("Padded");
    expect(visit("https://example.com/x", { title: "   " })!.title).toBeUndefined();
  });
});

describe("site enrichment integration — not YouTube-specific", () => {
  it("enriches a YouTube video visit with siteKind/siteRef", () => {
    const v = visit("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { title: "Never Gonna Give You Up" });
    expect(v!.siteKind).toBe("video");
    expect(v!.siteRef).toBe("dQw4w9WgXcQ");
    const e = toAgentEvent(v!);
    expect(e.detail.siteKind).toBe("video");
    expect(e.detail.siteRef).toBe("dQw4w9WgXcQ");
    expect(e.detail.title).toBe("Never Gonna Give You Up");
  });

  it("enriches a GitHub repository visit the same way, via the same mechanism", () => {
    const v = visit("https://github.com/anthropics/claude-code", { title: "anthropics/claude-code" });
    expect(v!.siteKind).toBe("repository");
    expect(v!.siteRef).toBe("anthropics/claude-code");
  });

  it("leaves an unrecognised site's visit with no siteKind/siteRef", () => {
    const v = visit("https://chatgpt.com/c/abc123", { title: "ChatGPT" });
    expect(v!.siteKind).toBeUndefined();
    expect(v!.siteRef).toBeUndefined();
    // The visit is still fully recorded — enrichment is additive, never a gate.
    expect(v!.domain).toBe("chatgpt.com");
    expect(toAgentEvent(v!).detail.title).toBe("ChatGPT");
  });

  it("never enriches a site the capture rules already excluded", () => {
    // A NEVER_RECORD site returns null from toVisit before enrichment ever
    // runs — proving enrichment cannot resurrect a blocked visit by way of
    // carrying detail that looks like a legitimate one.
    expect(visit("https://www.paypal.com/watch?v=x", {}, FLOOR)).toBeNull();
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
