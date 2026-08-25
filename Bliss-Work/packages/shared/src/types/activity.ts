/**
 * The unified activity detail contract.
 *
 * ── Why this is not a new activity model ─────────────────────────────────────
 * `TimelineEntry` (types/domain.ts) already has everything a row needs:
 * `source` (who reported it), `category`/`action` (what happened), `targetKind`/
 * `targetId` (the aggregatable destination — an app name or a registrable
 * domain, stored in the clear because every rollup groups by it), `durationMs`,
 * and `detail` — a free-form `Record<string, string>`, encrypted per-org,
 * reserved for exactly the kind of revealing-but-not-aggregatable context a
 * richer activity line needs (see ingest.py's ActivityRow docstring: "Holds the
 * parts that are revealing rather than aggregatable").
 *
 * A page title, a window title, a full URL, and a browser name are all that
 * kind of value. They belong in `detail`, which four producers (web beacon,
 * desktop beacon, desktop agent, browser extension) already write to and one
 * reader (telemetry-svc's timeline handler) already decrypts and returns
 * unchanged. Adding a second, parallel place to carry this would fork the
 * activity model the rest of the product already relies on; this file instead
 * names the keys that belong in the bag every producer already has, so they
 * stop being an informal convention and start being one every producer and
 * reader can rely on spelling the same way.
 *
 * ── Backward compatibility ────────────────────────────────────────────────────
 * Every key here is OPTIONAL. `detail` is already `nullable` end-to-end
 * (BeaconEvent/AgentEvent on the way in, TimelineEntry on the way out), so a
 * row from before this contract existed simply has none of these keys, and a
 * reader that does not know about a key ignores it — exactly how `detail.from`
 * already works for `switchLabel()` in activityLabels.ts. No migration, no
 * schema change, no new endpoint.
 */

/** Where the reported context lets a browser-family split behave uniformly —
 *  Chromium engines first (see the WebExtensions strategy this mirrors), plus
 *  the two non-Chromium engines expected later. Not `desktop`/`extension` —
 *  that split is `TimelineEntry.source`, this is which *browser* it was. */
export type ActivityBrowser =
  | "chrome"
  | "edge"
  | "brave"
  | "opera"
  | "arc"
  | "firefox"
  | "safari";

/**
 * The formalized keys of `TimelineEntry.detail` / `AgentEvent.detail` /
 * `BeaconEvent.detail`.
 *
 * Every field maps onto an existing producer's existing output:
 *   - `title`    the page title (browser sensor) or window title (desktop
 *                sensor) — "Learn Go in 30 Minutes", "activity.go - BlissWork".
 *   - `browser`  which browser reported a `site.visit` row — lets a future
 *                Firefox/Safari sensor share the same `action`/`category`
 *                without a new activity type.
 *   - `process`  the OS process/executable name, when it differs from the
 *                human-facing `targetId` (which already holds the resolved
 *                app name — see policy/activityDestination.ts's `resolveApp`).
 *   - `domain`   the registrable domain, mirrored into `detail` for a
 *                `site.visit` row when `targetId` already holds it — present so
 *                a reader never has to re-derive the domain from `url`.
 *   - `url`      the full page URL. Already written by the extension today
 *                (see apps/extension/src/tracker.ts's `toAgentEvent`) —
 *                formalized here, not introduced.
 *   - `from`     already in production use (see activityLabels.ts's
 *                `destinationOf`) — the raw reading of wherever the person
 *                switched from. Included so this type is a complete picture of
 *                the bag, not a partial one that invites a second convention.
 *   - `siteKind` what KIND of thing the page represents, when a site-specific
 *                enricher recognised it — "video", "repository", "document",
 *                and so on. Generic on purpose: this is the extension point
 *                for "GitHub repository", "Google Docs document", and whatever
 *                is added after them, without a new field per site. Absent
 *                when no enricher matched the page, which is the common case.
 *   - `siteRef`  the site's OWN identifier for the thing `siteKind` names — a
 *                YouTube video id, a GitHub `owner/repo`, a Docs document id.
 *                Meaningless without `siteKind` alongside it; set together.
 *
 * This is a type, not a runtime schema: `detail` on the wire stays
 * `Record<string, string>` (Beacon/Agent event bodies are bounded and validated
 * server-side in schemas.py, not client-side), and this describes the subset of
 * that record's keys a producer SHOULD use for these concepts, so "the page
 * title" is spelled `title` everywhere rather than once as `pageTitle` and once
 * as `windowTitle`.
 */
export interface ActivityDetail {
  title?: string;
  browser?: ActivityBrowser | (string & {});
  process?: string;
  domain?: string;
  url?: string;
  from?: string;
  siteKind?: string;
  siteRef?: string;
}
