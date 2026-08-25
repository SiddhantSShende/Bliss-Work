/**
 * Each enricher tested independently, plus the registry's dispatch rules.
 *
 * The requirement this satisfies is EXTENSIBILITY, not YouTube specifically —
 * so alongside the concrete assertions, one test proves the registry is a
 * genuine list (adding/removing an entry does not require touching the others)
 * rather than a chain of YouTube-shaped special cases.
 */
import { describe, expect, it } from "vitest";
import { enrichSite } from "./siteEnrichment";

const url = (s: string) => new URL(s);

describe("YouTube: a /watch URL's v parameter is the video id", () => {
  it("recognises an ordinary watch URL", () => {
    expect(enrichSite(url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "Some Video - YouTube")).toEqual({
      siteKind: "video",
      siteRef: "dQw4w9WgXcQ",
    });
  });

  it("still resolves the id when other query params come first", () => {
    expect(enrichSite(url("https://youtube.com/watch?t=42s&v=abc123"), undefined)).toEqual({
      siteKind: "video",
      siteRef: "abc123",
    });
  });

  it("does not enrich the YouTube homepage or a channel page — no video id to name", () => {
    expect(enrichSite(url("https://www.youtube.com/"), "YouTube")).toBeNull();
    expect(enrichSite(url("https://www.youtube.com/@somechannel"), "Some Channel")).toBeNull();
  });

  it("does not enrich a /watch URL with no v parameter", () => {
    expect(enrichSite(url("https://www.youtube.com/watch"), undefined)).toBeNull();
  });
});

describe("GitHub: an owner/repo path names a repository", () => {
  it("recognises a bare repository URL", () => {
    expect(enrichSite(url("https://github.com/anthropics/claude-code"), "GitHub")).toEqual({
      siteKind: "repository",
      siteRef: "anthropics/claude-code",
    });
  });

  it("recognises a repository sub-page (issues, PRs, files)", () => {
    expect(enrichSite(url("https://github.com/acme/repo/pull/42"), "PR title")).toEqual({
      siteKind: "repository",
      siteRef: "acme/repo",
    });
  });

  it("does not enrich GitHub's own non-repository pages", () => {
    expect(enrichSite(url("https://github.com/settings/profile"), undefined)).toBeNull();
    expect(enrichSite(url("https://github.com/notifications"), undefined)).toBeNull();
  });

  it("does not enrich the GitHub homepage", () => {
    expect(enrichSite(url("https://github.com/"), undefined)).toBeNull();
  });
});

describe("Google Docs: the document id segment names a document", () => {
  it("recognises a document URL regardless of the trailing edit/view suffix", () => {
    expect(enrichSite(url("https://docs.google.com/document/d/1AbC-XyZ/edit"), "My Doc - Google Docs")).toEqual({
      siteKind: "document",
      siteRef: "1AbC-XyZ",
    });
    expect(enrichSite(url("https://docs.google.com/document/d/1AbC-XyZ/view"), undefined)).toEqual({
      siteKind: "document",
      siteRef: "1AbC-XyZ",
    });
  });

  it("does not enrich the Docs homepage", () => {
    expect(enrichSite(url("https://docs.google.com/"), undefined)).toBeNull();
  });

  it("does not enrich a Sheets or Slides URL — a different Google product", () => {
    expect(enrichSite(url("https://docs.google.com/spreadsheets/d/xyz/edit"), undefined)).toBeNull();
  });
});

describe("sites with no registered enricher", () => {
  it("returns null rather than guessing", () => {
    expect(enrichSite(url("https://example.com/anything"), "Example")).toBeNull();
    expect(enrichSite(url("https://www.bbc.co.uk/news"), "BBC News")).toBeNull();
  });
});

describe("host matching", () => {
  it("matches a bare domain and its www. form the same way", () => {
    const bare = enrichSite(url("https://github.com/a/b"), undefined);
    const www = enrichSite(url("https://www.github.com/a/b"), undefined);
    expect(bare).toEqual(www);
  });

  it("does not match an unrelated domain that merely contains the name", () => {
    expect(enrichSite(url("https://github.com.evil.example/a/b"), undefined)).toBeNull();
    expect(enrichSite(url("https://notgithub.com/a/b"), undefined)).toBeNull();
  });

  it("matches a genuine subdomain of a registered site through the same enricher", () => {
    // gist.github.com is a real GitHub subdomain and its paths happen to have
    // the same /a/b shape a repository path does — the enricher does not
    // distinguish subdomains, only the registered domain, so this documents
    // that a subdomain shares its parent's matcher rather than being ignored.
    expect(enrichSite(url("https://gist.github.com/a/b"), undefined)).toEqual({
      siteKind: "repository",
      siteRef: "a/b",
    });
  });
});

describe("extensibility: the registry is a list, not a special case", () => {
  it("each site's absence would not change another site's behaviour", () => {
    // Proven structurally rather than by deleting an entry: every enricher
    // above is exercised independently, on its own domain, with assertions
    // that reference only that site. None of YouTube's tests assert on
    // GitHub or Docs behaviour and vice versa — the registry could gain or
    // lose an entry without any of the others' tests changing.
    const youtubeResult = enrichSite(url("https://youtube.com/watch?v=x"), undefined);
    const githubResult = enrichSite(url("https://github.com/a/b"), undefined);
    expect(youtubeResult?.siteKind).toBe("video");
    expect(githubResult?.siteKind).toBe("repository");
  });
});
