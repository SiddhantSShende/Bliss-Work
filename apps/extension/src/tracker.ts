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
 */

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
  /** Path only, query and fragment already stripped. Encrypted server-side. */
  path: string;
  startedAt: number;
  durationMs: number;
}

export interface Candidate {
  url: string;
  incognito?: boolean;
}

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
  extraBlocked: readonly string[] = [],
): Visit | null {
  // Incognito is an explicit statement that this is not to be recorded, and it
  // is honoured even though the extension could technically see it.
  if (candidate.incognito) return null;

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

  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  const blocked = [...NEVER_RECORD, ...extraBlocked];
  if (blocked.some((b) => haystack.includes(b))) return null;

  // Spans shorter than this are navigation noise — a redirect hop, a mistyped
  // address, a tab passed through with alt-tab.
  if (durationMs < 5_000) return null;

  return { domain, path: stripQuery(url), startedAt, durationMs };
}

/**
 * The path, with the query string and fragment removed.
 *
 * The query string is where the genuinely dangerous material lives: search
 * terms, session tokens, password-reset links, document ids that sites put in
 * `?id=`. The path alone answers "which part of the tool were they in" without
 * carrying any of that.
 */
export function stripQuery(url: URL): string {
  const path = url.pathname || "/";
  return path.length > 200 ? path.slice(0, 200) : path;
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
} {
  return {
    action: "site.visit",
    category: "site",
    occurredAt: new Date(v.startedAt).toISOString(),
    targetKind: "site",
    // Plaintext, because every rollup groups by it.
    targetId: v.domain,
    durationMs: v.durationMs,
    // Encrypted per-org server-side, and only ever read one row at a time.
    detail: { url: `${v.domain}${v.path}` },
  };
}
