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
  /** Path + query + fragment, bounded. The full URL, encrypted server-side. */
  path: string;
  startedAt: number;
  durationMs: number;
}

export interface Candidate {
  url: string;
  incognito?: boolean;
}

/**
 * How aggressively to record. Server-pushable so a workspace can be dialled back
 * for a jurisdiction without reshipping the extension.
 *
 * The DEFAULTS capture everything — that is the configured behaviour for this
 * deployment. The gates exist so the safety floor (NEVER_RECORD, incognito) can
 * be switched back ON without a code change, not because it is on by default.
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
): Visit | null {
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

  // Spans shorter than this are navigation noise — a redirect hop, a mistyped
  // address, a tab passed through with alt-tab.
  if (durationMs < 5_000) return null;

  return { domain, path: fullPath(url), startedAt, durationMs };
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
