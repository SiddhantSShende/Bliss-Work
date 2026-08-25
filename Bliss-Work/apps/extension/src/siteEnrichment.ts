/**
 * Site-specific enrichment: what a page's URL says about the THING it shows,
 * beyond "this is a page on this domain".
 *
 * `tracker.ts` already knows the domain and the full path — the generic,
 * site-agnostic half of a visit. This file is the extension point for the
 * other half: recognising that a youtube.com URL names a video, a github.com
 * URL names a repository, a docs.google.com URL names a document, and saying
 * so in a shape the unified activity model already has room for
 * (`ActivityDetail.siteKind` / `siteRef` — see packages/shared/src/types/
 * activity.ts).
 *
 * ── Why a registry, not an if/else chain headed by YouTube ──────────────────
 * The requirement this file exists to satisfy is "extensibility for
 * site-specific enrichment", not "YouTube support". A registry of independent,
 * individually testable matchers is what makes GitHub and Google Docs (and
 * whatever comes after them) additions rather than edits to a growing
 * conditional — the same shape as `activityDestination.ts`'s SITE_NAMES /
 * APP_NAMES lookup tables elsewhere in this codebase. YouTube is the FIRST
 * entry in the list below, not a special case the list is built around; the
 * list works identically with it removed.
 *
 * ── Why this stays free of `chrome.*` ────────────────────────────────────────
 * Same reason as tracker.ts: an enricher is a pure function of a URL and a
 * title, so it is testable without an MV3 service worker and portable to a
 * Firefox/Safari build without rewriting a line of it.
 */

export interface SiteEnrichment {
  /** What KIND of thing the page represents — "video", "repository",
   *  "document". Free text by design (see ActivityDetail.siteKind): a new
   *  enricher introduces a new kind by returning one, not by extending a
   *  closed enum somewhere else. */
  siteKind: string;
  /** The site's own identifier for the thing `siteKind` names. */
  siteRef: string;
}

interface Enricher {
  /** A short name for the enricher itself, used only in tests/debugging —
   *  never sent anywhere. */
  name: string;
  domain: string;
  enrich: (url: URL, title: string | undefined) => SiteEnrichment | null;
}

/**
 * YouTube: a `/watch` URL's `v` parameter is the video id, which is stable and
 * precise — far better than parsing one out of the title, which channels are
 * free to format however they like. The title itself is not otherwise
 * touched here: YouTube already suffixes it with " - YouTube", which
 * `toAgentEvent`/the timeline can strip or not as a display concern, not a
 * capture concern.
 */
const youtube: Enricher = {
  name: "youtube",
  domain: "youtube.com",
  enrich: (url) => {
    if (url.pathname !== "/watch") return null;
    const id = url.searchParams.get("v");
    if (!id) return null;
    return { siteKind: "video", siteRef: id };
  },
};

/**
 * GitHub: `/owner/repo` or `/owner/repo/...` names a repository. Deliberately
 * excludes GitHub's own non-repository top-level paths (`/settings`,
 * `/notifications`, `/marketplace`, ...) via the same two-path-segment shape
 * every repository URL has, rather than an allowlist of what a repo path
 * looks like — a repo named "settings" is indistinguishable from the URL
 * alone, and false-positiving on it is a materially smaller error than an
 * allowlist that quietly rejects a repo whose owner or name happens to fall
 * outside it.
 */
const RESERVED_TOP_LEVEL = new Set([
  "settings", "notifications", "marketplace", "explore", "topics", "trending",
  "sponsors", "collections", "events", "issues", "pulls", "codespaces", "orgs",
  "enterprise", "about", "pricing", "features", "security", "apps", "new",
]);

const github: Enricher = {
  name: "github",
  domain: "github.com",
  enrich: (url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo || RESERVED_TOP_LEVEL.has(owner)) return null;
    return { siteKind: "repository", siteRef: `${owner}/${repo}` };
  },
};

/**
 * Google Docs: `/document/d/<id>/...` — the id segment is Google's own stable
 * reference for the document, present in every Docs URL regardless of the
 * trailing edit/view suffix.
 */
const googleDocs: Enricher = {
  name: "google-docs",
  domain: "docs.google.com",
  enrich: (url) => {
    const match = /^\/document\/d\/([^/]+)/.exec(url.pathname);
    const id = match?.[1];
    if (!id) return null;
    return { siteKind: "document", siteRef: id };
  },
};

/**
 * Every registered enricher. Order does not matter — each is scoped to its
 * own `domain` and at most one can ever match a given URL.
 *
 * Adding a site is adding an entry here, not touching `tracker.ts` or any
 * `background.ts` event handler.
 */
const ENRICHERS: readonly Enricher[] = [youtube, github, googleDocs];

/**
 * Enrich a visited URL, if a registered site recognises it.
 *
 * Returns null for everything not covered — which is the overwhelming
 * majority of the web, and exactly as informative as recording nothing extra:
 * `tracker.ts`'s domain/path capture already describes the visit, and this is
 * additive detail, never a requirement for a visit to be recorded at all.
 */
export function enrichSite(url: URL, title: string | undefined): SiteEnrichment | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const enricher of ENRICHERS) {
    if (host !== enricher.domain && !host.endsWith(`.${enricher.domain}`)) continue;
    const result = enricher.enrich(url, title);
    if (result) return result;
  }
  return null;
}
