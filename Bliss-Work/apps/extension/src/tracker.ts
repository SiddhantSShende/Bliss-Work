/**
 * What gets recorded about a browsing session, and what does not.
 *
 * Deliberately free of every `chrome.*` API so the rules below can be tested as
 * plain functions. An MV3 service worker is killed and restarted constantly;
 * logic that only runs inside one is logic that is never exercised until it is
 * wrong in production.
 *
 * The shape of a record is a SPAN, not a page-load: "github.com for 23 minutes"
 * is the useful fact. A stream of navigation events would be both larger and
 * less informative.
 *
 * The page TITLE is captured alongside the URL (Chrome's `tabs` permission,
 * already declared, is what exposes it) and, where a site is recognised by
 * `siteEnrichment.ts`, a generic `siteKind`/`siteRef` pair naming what the
 * page actually shows — a YouTube video id, a GitHub repository, and so on.
 * None of this is full page content: it is exactly what a browser tab already
 * advertises about itself (its title, its URL) plus a parse of that same URL,
 * never anything read out of the page.
 */
import { enrichSite, type SiteEnrichment } from "./siteEnrichment";

/** Schemes that are not the web and cannot meaningfully be "visited". */
const IGNORED_SCHEMES = ["chrome:", "chrome-extension:", "about:", "edge:", "brave:",
  "devtools:", "view-source:", "file:", "data:", "blob:"];

/**
 * Categories nobody should be building a record of, regardless of who asked.
 *
 * This is a floor, not a policy: an organisation can add to it, and the server
 * can push more, but these are never recorded even if someone configures it to.
 * A workplace monitoring tool that quietly logs a colleague's visits to a
 * bank, a hospital or a legal-aid site has stopped being a workplace monitoring
 * tool.
 */
const NEVER_RECORD = [
  // Health
  "nhs.uk", "webmd.com", "mayoclinic.org", "healthline.com", "plannedparenthood.org",
  // Finance / banking
  "paypal.com", "wise.com", "revolut.com", "chase.com", "hsbc.com", "barclays.co.uk",
  "monzo.com", "coinbase.com",
  // Government, legal aid, and support services
  "gov.uk", "irs.gov", "ssa.gov", "citizensadvice.org.uk", "samaritans.org",
  // Job hunting — recording it turns a monitoring tool into a retaliation tool.
  "indeed.com", "glassdoor.com", "linkedin.com/jobs",
];

export interface Visit {
  /** Registrable domain — the aggregatable half, stored in the clear. */
  domain: string;
  /** Path + query + fragment, bounded. The full URL, encrypted server-side. */
  path: string;
  startedAt: number;
  durationMs: number;
  /**
   * Where the user came FROM to reach this one — a registrable domain, or the
   * BlissWork marker. Absent when there was no previous site, or when the
   * previous site was one that may not be recorded (see `recordableSite`).
   *
   * That last case is the point of carrying it here rather than deriving it in
   * the UI: without it, a hop from a bank to YouTube would publish the bank on
   * the YouTube row, which is exactly what NEVER_RECORD exists to prevent.
   */
  from?: string;
  /** The tab's title at the moment the span closed — exactly what the browser
   *  itself displayed, nothing read out of the page. Absent when the tab
   *  reported none (a page mid-load, an extension the browser gives no title
   *  for). See `enrichSite` for why this is also an input to enrichment, not
   *  only a display string. */
  title?: string;
  /** What KIND of thing the page represents ("video", "repository",
   *  "document"), when a registered enricher recognised it. See
   *  siteEnrichment.ts. Absent for the overwhelming majority of the web, which
   *  is not a gap — the domain/path already describe the visit. */
  siteKind?: string;
  /** The site's own identifier for what `siteKind` names — a YouTube video id,
   *  a GitHub `owner/repo`. Always set together with `siteKind`. */
  siteRef?: string;
}

/**
 * How the timeline says "they were in BlissWork itself".
 *
 * Must match BLISSWORK_DESTINATION in packages/shared. Not imported: this
 * extension ships as a dependency-free esbuild bundle, deliberately, so that
 * what runs in a member's browser is auditable without following it into the
 * web application's package tree.
 */
export const SELF = "BlissWork";

export interface Candidate {
  url: string;
  incognito?: boolean;
  /** The tab's title, when the browser has one to give — same permission
   *  (`tabs`) that already exposes `url`, no new grant required. */
  title?: string;
}

/**
 * How aggressively to record. Per-device only (background.ts reads these from
 * `chrome.storage.local`, never from managed policy — see managed-schema.json's
 * own comment on why), so this cannot be pushed to a fleet from a single
 * settings change.
 *
 * The DEFAULTS are the safety floor: an absent/undefined flag reads as `false`
 * (background.ts's `captureOpts` uses `=== true`), so NEVER_RECORD and the
 * incognito exclusion apply unless a person explicitly opts a specific device
 * out. The gates exist to switch the floor OFF when someone deliberately wants
 * that, not because comprehensive capture is the shipped behaviour.
 */
export interface CaptureConfig {
  /** true = ignore the NEVER_RECORD category floor. */
  captureAll?: boolean;
  /** true = record private/incognito windows too. */
  captureIncognito?: boolean;
  /** Extra host/path fragments the org has chosen to never record. Always
   *  honoured, whatever captureAll is — an org's own opt-outs are not overridden. */
  extraBlocked?: readonly string[];
}

/** The longest URL we keep. Query strings can be enormous (analytics params,
 *  encoded state); past this the tail carries no signal worth the storage. */
const MAX_URL_CHARS = 512;

/**
 * The registrable domain, roughly.
 *
 * "Roughly" is honest: doing this exactly needs the Public Suffix List, which is
 * ~230KB and would have to ship and be kept current inside the extension. The
 * approximation takes the last two labels, with a small allowance for the
 * common two-part suffixes, and the cost of being wrong is that "bbc.co.uk"
 * might group as "co.uk" — an aggregation artefact, never a privacy leak, since
 * the full host is already inside what we are permitted to record.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.in", "com.au", "co.nz",
  "com.br", "co.za", "com.sg", "com.mx",
]);

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * Turn a tab into something recordable, or null.
 *
 * Returns null — rather than recording a redacted placeholder — for anything
 * excluded. A row saying "visited [redacted] for 40 minutes" is still a
 * disclosure that they were somewhere they did not want recorded.
 */
export function toVisit(
  candidate: Candidate,
  startedAt: number,
  durationMs: number,
  opts: CaptureConfig = {},
  from?: string,
): Visit | null {
  const site = recordableSite(candidate, opts);
  if (!site) return null;

  // Spans shorter than this are navigation noise — a redirect hop, a mistyped
  // address, a tab passed through with alt-tab.
  if (durationMs < 5_000) return null;

  const title = candidate.title?.trim() || undefined;
  // Enrichment runs on a site that has ALREADY cleared `recordableSite` — a
  // blocked domain never reaches here, so a bank's account page can never
  // produce a `siteKind`/`siteRef` regardless of what its URL looks like.
  const enrichment = enrichUrl(candidate.url, title);

  return {
    ...site,
    startedAt,
    durationMs,
    ...(from ? { from } : {}),
    ...(title ? { title } : {}),
    ...(enrichment ? enrichment : {}),
  };
}

/** Parse-and-enrich, tolerant of the same malformed input `recordableSite`
 *  already guards against — `toVisit` only reaches here after that guard has
 *  passed, but this stays defensive rather than assuming the URL still parses
 *  identically the second time. */
function enrichUrl(rawUrl: string, title: string | undefined): SiteEnrichment | null {
  try {
    return enrichSite(new URL(rawUrl), title);
  } catch {
    return null;
  }
}

/**
 * May this site be recorded at all, and under what name?
 *
 * Every rule in `toVisit` EXCEPT the duration minimum, which is about whether a
 * span is worth keeping rather than whether a site may be named. Split out so
 * the "switched from" half can ask the identical question: the previous site
 * appears on the NEXT site's row, so it has to clear the same bar, and a second
 * copy of the blocklist here is precisely how a bank would eventually leak onto
 * a YouTube row.
 *
 * The duration rule must NOT apply to that use. A four-second glance at a blocked
 * site is still a blocked site, and it is still not worth naming as a source —
 * but a four-second glance at an ordinary one is a perfectly good answer to
 * "where did they come from", even though it is too short to be a visit of its
 * own.
 */
export function recordableSite(
  candidate: Candidate,
  opts: CaptureConfig = {},
): { domain: string; path: string } | null {
  // Incognito is an explicit "do not record this". Honoured UNLESS the workspace
  // has turned that off. The extension can technically see it either way; whether
  // it records it is the configured decision.
  if (candidate.incognito && !opts.captureIncognito) return null;

  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return null;
  }
  if (IGNORED_SCHEMES.some((s) => url.protocol === s)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const domain = registrableDomain(url.hostname);
  if (!domain || !domain.includes(".")) return null; // localhost, intranet hostnames

  // The org's own extra blocklist is ALWAYS honoured. The built-in sensitive-
  // category floor applies only when captureAll is off — the switch that lets a
  // jurisdiction be dialled back without a reship.
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  const blocked = [...(opts.captureAll ? [] : NEVER_RECORD), ...(opts.extraBlocked ?? [])];
  if (blocked.some((b) => haystack.includes(b))) return null;

  return { domain, path: fullPath(url) };
}

/**
 * The path, query and fragment together — the full URL after the host, bounded.
 *
 * Records exactly what the person was looking at: `/watch?v=<video>`,
 * `/search?q=<terms>`. The query string is deliberately KEPT — it is where "what
 * they did" lives. It is also where session tokens and reset links can live,
 * which is why this half is stored encrypted per-org server-side and only ever
 * read one row at a time, never aggregated.
 */
export function fullPath(url: URL): string {
  const s = (url.pathname || "/") + url.search + url.hash;
  return s.length > MAX_URL_CHARS ? s.slice(0, MAX_URL_CHARS) : s;
}

/** The wire shape the agent-ingest endpoint accepts. */
export function toAgentEvent(v: Visit): {
  action: string;
  category: string;
  occurredAt: string;
  targetKind: string;
  targetId: string;
  durationMs: number;
  detail: Record<string, string>;
  clientEventId: string;
} {
  // Formalized ActivityDetail keys (packages/shared/src/types/activity.ts):
  // `domain` is mirrored alongside the plaintext targetId so a reader of
  // `detail` never has to re-derive it from `url`; `title`/`siteKind`/
  // `siteRef` are the enrichment this file adds on top of the domain/path
  // capture every visit already had.
  const detail: Record<string, string> = {
    url: `${v.domain}${v.path}`,
    domain: v.domain,
    ...(v.from ? { from: v.from } : {}),
    ...(v.title ? { title: v.title } : {}),
    ...(v.siteKind ? { siteKind: v.siteKind } : {}),
    ...(v.siteRef ? { siteRef: v.siteRef } : {}),
  };
  return {
    action: "site.visit",
    category: "site",
    occurredAt: new Date(v.startedAt).toISOString(),
    targetKind: "site",
    // Plaintext, because every rollup groups by it.
    targetId: v.domain,
    durationMs: v.durationMs,
    // Encrypted per-org server-side, and only ever read one row at a time.
    detail,
    // Generated once, here, and never touched again — enqueue()/flush() only
    // ever re-send the object already in chrome.storage.session's queue, so a
    // retry after a lost response carries the SAME id. Lets the server
    // collapse it into a no-op instead of a duplicate row; see
    // migration 0006_activity_event_idempotency.sql.
    clientEventId: crypto.randomUUID(),
  };
}

/**
 * The registrable domain BlissWork itself is served from, derived from the
 * enrolled API base.
 *
 * Used to recognise the member's own BlissWork tab as a source, so the timeline
 * can say "switched from BlissWork to YouTube" instead of naming the host the
 * workspace happens to live on. Derived rather than configured: the ingest base
 * is already provisioned by pairing or by managed policy, and a second setting
 * that could disagree with it would be one more thing to get wrong.
 */
export function selfDomain(apiBase: string | undefined): string | null {
  if (!apiBase) return null;
  try {
    return registrableDomain(new URL(apiBase).hostname);
  } catch {
    return null;
  }
}
