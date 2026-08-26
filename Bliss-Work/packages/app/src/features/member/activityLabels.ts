/**
 * Turning stored activity into English.
 *
 * The store keeps stable machine verbs (`task.completed`, `route.dwell`) so the
 * aggregates can group on them for years. This is the only place they become
 * words, which means renaming a label never touches the data and never
 * invalidates a rollup.
 */
import {
  isBlissWork,
  isBrowser,
  resolveDestination,
  type ActivitySessionEntryDTO,
  type ActivitySource,
  type TimelineEntry,
} from "@taskboard/shared";

/**
 * "They are back."
 *
 * Named because two different rows mean it — the web client's `focus` event, and
 * a foreground switch whose destination is BlissWork itself — and a person
 * reading the timeline should not be able to tell which producer noticed.
 */
const CAME_BACK = "Came back to BlissWork";

const ACTIONS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  "org.switched": "Switched workspace",
  "message.sent": "Sent a message",
  "channel.message.sent": "Posted in a channel",
  "conversation.ignored": "Ignored a conversation",
  "user.blocked": "Blocked someone",
  "user.unblocked": "Unblocked someone",
  "task.allocated": "Allocated a task",
  "task.acknowledged": "Acknowledged a task",
  "task.completed": "Completed a task",
  "task.ignored": "Ignored a task",
  "task.left": "Left a task",
  "task.reviewed": "Reviewed a task",
  "route.enter": "Opened",
  "route.dwell": "Spent time in",
  "app.focus": "Used",
  "site.visit": "Visited",
  focus: CAME_BACK,
  blur: "Switched away from BlissWork",
  "idle.start": "Went idle",
  "idle.end": "Became active",
  // Desktop-agent system events. These have been emitted since the agent
  // shipped but had no entries here, so they rendered as raw machine verbs.
  "screen.locked": "Locked their screen",
  "screen.unlocked": "Unlocked their screen",
  "system.suspended": "Put the machine to sleep",
  "screenshot.attempted": "Attempted a screenshot",
};

const SURFACES: Record<string, string> = {
  mail: "Mail",
  // What Mail was called before it was renamed. Kept because the timeline is
  // years of stored rows and the old ones still say "inbox".
  inbox: "Inbox",
  chats: "Chats",
  channels: "Channels",
  tasks: "Tasks",
  members: "Members",
  integrations: "Integrations",
  search: "Search",
  settings: "Settings",
  profile: "Profile",
  org: "Organization",
};

/**
 * Where a row says the person went, and where they came from, as names.
 *
 * `targetId` holds the raw fact the agent observed — an application name or a
 * registrable domain — and `detail.from` the same for whatever they left. Both
 * are resolved here rather than stored resolved, so the mapping can improve
 * without rewriting history. See policy/activityDestination.
 */
export function destinationOf(entry: TimelineEntry): {
  to: string | null;
  from: string | null;
} {
  return {
    to: resolveDestination(entry.targetKind, entry.targetId),
    from: resolveDestination(entry.targetKind, entry.detail?.from),
  };
}

export function actionLabel(entry: TimelineEntry, session?: ActivitySessionEntryDTO | null): string {
  const verb = ACTIONS[entry.action] ?? entry.action;
  // Navigation and usage rows read as "Opened Tasks" — the verb alone would be
  // meaningless for them.
  if (entry.action === "route.enter" || entry.action === "route.dwell") {
    return `${verb} ${surfaceLabel(entry.surface) ?? "the app"}`;
  }
  if (entry.action === "app.focus" || entry.action === "site.visit") {
    return switchLabel(entry, verb, session);
  }
  return verb;
}

/**
 * An app or site row, said as a transition where the row supports one.
 *
 * Three shapes, in descending order of what the row actually knows:
 *
 *   both ends   "Switched from BlissWork to YouTube" — the whole point of this
 *               feature, and the only form that answers where somebody went.
 *   arriving at "Came back to BlissWork" — a switch whose destination is us
 *               reads better as a return, and matches the `focus` event the web
 *               client emits for the same moment.
 *   one end     "Used VS Code" / "Visited youtube.com" — every row written
 *               before the agents recorded a source, and the first row after an
 *               agent starts. NOT dressed up as a switch: a row with no source
 *               cannot say what somebody switched from, and inventing BlissWork
 *               as the answer would be wrong exactly when the person had been
 *               somewhere else.
 *
 * `detail.title` — a page or window title, when the producer sent one — is
 * layered on afterwards by the caller (see `activityTitle`), not here: it
 * never changes which of the three shapes above applies, only whether a second
 * line accompanies it.
 *
 * `session` — the correlated `activity_sessions` record, when the caller
 * found one — refines WHERE "to" resolves to, not whether a switch is
 * reported at all. A desktop-only `app.focus` row for Chrome names "Chrome" as
 * its destination; if the sessionizer correlated it with a browser
 * `site.visit`, the session's `domain` ("youtube.com") is the more specific
 * answer to "where did they go" and wins — this is the exact mechanism that
 * turns "Switched to Chrome" into "Switched to YouTube". A `kind: "app"`
 * session (no browser signal) or no session at all leaves `to` exactly as
 * `destinationOf` already resolved it — no fabrication, only refinement of a
 * destination the row already names.
 */
function switchLabel(entry: TimelineEntry, verb: string, session?: ActivitySessionEntryDTO | null): string {
  const { to, from } = destinationOf(entry);
  const refined = session?.domain ? resolveDestination("site", session.domain) : null;
  const destination = refined ?? to;
  if (!destination) return `${verb} something`;
  if (isBlissWork(destination)) return CAME_BACK;
  if (!from) return `${verb} ${destination}`;
  return `Switched from ${from} to ${destination}`;
}

/**
 * A correlated `activity_sessions` record ("Chrome, showing YouTube,
 * 'Learn Go in 30 Minutes', 15:00-15:14") indexed by the `activity_events`
 * row id(s) it was built from, NOT by timestamp.
 *
 * Timestamp was tried first and is wrong: sessionizer.py's `_merged_span`
 * always anchors `activity_sessions.started_at` on the DESKTOP row's
 * `occurred_at`, but `collapseSwitches` (below) prefers the SITE row for
 * display whenever the two are within `SWITCH_MERGE_MS` of each other — and
 * the site row's own `occurredAt` is the browser extension's independent
 * clock reading, not a copy of the desktop timestamp. Any nonzero skew
 * between the two sensors' clocks — exactly the condition
 * `CORRELATION_TOLERANCE` exists to accommodate server-side — made a
 * timestamp-keyed lookup miss for the row that actually renders, silently
 * dropping title/Open-link/siteRef for sessions the backend had genuinely
 * correlated. Event ids don't drift, so indexing by `anchorEventId` AND
 * `correlatedEventId` (both point back to real `TimelineEntry.id`s) finds the
 * record regardless of which of the two rows survives `collapseSwitches`.
 *
 * A row this index has no entry for was written before this endpoint
 * existed, or the sessionizer had nothing to correlate it with yet; the
 * caller falls back to `switchLabel`'s existing TimelineEntry-only rendering
 * in that case.
 */
export type SessionEntryIndex = ReadonlyMap<string, ActivitySessionEntryDTO>;

export function indexSessionEntries(entries: readonly ActivitySessionEntryDTO[]): SessionEntryIndex {
  const byEventId = new Map<string, ActivitySessionEntryDTO>();
  for (const s of entries) {
    if (s.anchorEventId) byEventId.set(s.anchorEventId, s);
    if (s.correlatedEventId) byEventId.set(s.correlatedEventId, s);
  }
  return byEventId;
}

/** The correlated record for a `TimelineEntry`, or null when the index has
 *  none — meaningful only for `app.focus`/`site.visit` rows, the only
 *  categories `activity_sessions` covers. */
export function sessionEntryFor(
  entry: TimelineEntry, index: SessionEntryIndex | undefined,
): ActivitySessionEntryDTO | null {
  if (!index) return null;
  if (entry.action !== "app.focus" && entry.action !== "site.visit") return null;
  return index.get(entry.id) ?? null;
}

/**
 * The page/window title alongside a switch, when the row carries one.
 *
 * Prefers the correlated session's `title` when a `session` was found — the
 * SAME underlying fact (both come from the sensor's own `detail.title`), but
 * the session record is what the sessionizer actually merged, so reading
 * from it rather than the raw row is consistent with `switchLabel`'s
 * decision above and means a caller working from ONE session object gets a
 * self-consistent answer instead of mixing pre- and post-correlation data.
 *
 * Absent for every row recorded before a producer started sending
 * `detail.title` (every desktop/extension build up to this point, and the web
 * client's own `blur`/`focus` rows, which have no "other side" to name) —
 * callers render nothing extra in that case, which is exactly today's
 * behaviour. Only meaningful beside `app.focus`/`site.visit`; asking for it on
 * any other action is a caller error, not a data gap, so this does not guard
 * against it.
 */
export function activityTitle(entry: TimelineEntry, session?: ActivitySessionEntryDTO | null): string | null {
  const title = (session?.title ?? entry.detail?.title)?.trim();
  return title ? title : null;
}

/**
 * A site-specific enrichment line, when one is available — "blisswork/backend"
 * for a GitHub row, and generically anything a registered enricher recognised
 * (see apps/extension/src/siteEnrichment.ts's registry: YouTube, GitHub,
 * Google Docs today). Only ever comes from the correlated session record —
 * `siteRef` is never invented client-side, and a row with no session or whose
 * session carries no `siteRef` renders nothing here, falling back to
 * `activityTitle`/the plain destination name exactly as before this existed.
 *
 * Deliberately generic rather than named per-site: this is the SAME
 * extensibility point siteEnrichment.ts's own registry is built around —
 * "a repository", "a document" are `siteKind` values this function does not
 * need to know about individually to render `siteRef` beside them.
 */
export function siteContext(session?: ActivitySessionEntryDTO | null): string | null {
  const ref = session?.detail?.siteRef?.trim();
  return ref ? ref : null;
}

/**
 * A clickable `https://` URL for this row, or null when there is none to
 * offer — the `[Open]` affordance only ever appears when this returns a
 * value, never as a dead button.
 *
 * `detail.url` is stored as `domain + path` with NO scheme (see
 * apps/extension/src/tracker.ts's `toAgentEvent`: `` `${v.domain}${v.path}` ``
 * — a bare string like "youtube.com/watch?v=…", never itself a valid href).
 * `https://` is prefixed here, once, in the one place that turns recorded
 * activity into a link — never assumed by a caller, and never a fabricated
 * URL: if `url.detail` is absent, this returns null rather than constructing
 * something from `targetId`/`domain` alone, which would at best guess a path
 * that does not exist and at worst imply the browser sensor recorded a full
 * URL for a row that never carried one.
 *
 * Validated with the actual `URL` constructor — matching this codebase's
 * existing http(s)-only convention (see chatFormat.ts's `URL_PATTERN`) —
 * rather than trusted as a string: a malformed or unexpected `detail.url`
 * (a future producer bug, a value truncated by AgentEvent's 2048-char detail
 * cap) fails closed to "no link" instead of rendering an href that does not
 * go where it claims to.
 *
 * Only meaningful beside `app.focus`/`site.visit`, same convention as
 * `activityTitle`: asking for it on another action is a caller error, not a
 * data gap, so this does not itself guard against it — `Row` in
 * MemberTimeline.tsx only calls this for switch rows.
 */
export function activityUrl(entry: TimelineEntry, session?: ActivitySessionEntryDTO | null): string | null {
  const raw = (session?.detail?.url ?? entry.detail?.url)?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether `row` says the same thing as `finer` but with less information, and
 * should therefore not be shown beside it.
 *
 * Three producers watch the same moment from different distances, and a switch
 * that all three notice would otherwise appear three times:
 *
 *   * the WEB client sees its own tab hide and emits `blur`. It cannot know
 *     where the person went — browsers do not expose that, deliberately — so
 *     its row is the least informative version of the same event.
 *   * the DESKTOP agent sees `Google Chrome` come to the front. True, and
 *     nearly useless: which site is the thing worth reading.
 *   * the EXTENSION sees `youtube.com`. This is the answer.
 *
 * Only ever collapses ADJACENT rows within a few seconds of each other, and only
 * ever in favour of a row that names a real destination. Two genuine switches
 * minutes apart are two rows; a browser row with no site row beside it survives,
 * because then it IS the best available answer.
 */
function supersededBy(row: TimelineEntry, finer: TimelineEntry): boolean {
  const gapMs = Math.abs(
    new Date(finer.occurredAt).getTime() - new Date(row.occurredAt).getTime(),
  );
  if (!Number.isFinite(gapMs) || gapMs > SWITCH_MERGE_MS) return false;

  const fine = destinationOf(finer);
  // The finer row has to actually name somewhere, and somewhere that is not us
  // — "came back to BlissWork" supersedes nothing.
  if (!fine.to || isBlissWork(fine.to)) return false;

  // The web client's blur: same moment, no destination.
  if (row.action === "blur") return fine.from === null || isBlissWork(fine.from);

  // A browser in the foreground, described more precisely by a site row.
  if (row.action === "app.focus" && finer.action === "site.visit") {
    return isBrowser(destinationOf(row).to);
  }
  return false;
}

/**
 * How far apart two readings of the same switch can land.
 *
 * The producers report on different schedules — the web client on
 * `visibilitychange`, the extension when it closes a span, the desktop agent on
 * a fifteen-second sample — so the same switch reaches the store with a spread.
 * Twenty seconds covers that without reaching a genuinely separate switch,
 * which the fifteen-second span minimum already keeps further apart than this.
 */
const SWITCH_MERGE_MS = 20_000;

/**
 * Drop rows that a neighbour describes better. Order-preserving, and safe on a
 * paginated list: it only ever compares a row with the ones beside it, so a page
 * boundary costs at most one un-collapsed duplicate rather than a wrong answer.
 */
export function collapseSwitches(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.filter((row, i) => {
    const before = entries[i - 1];
    const after = entries[i + 1];
    return !(
      (before && supersededBy(row, before)) || (after && supersededBy(row, after))
    );
  });
}

export function surfaceLabel(surface: string | null): string | null {
  if (!surface) return null;
  return SURFACES[surface] ?? surface;
}

/** "2h 14m", "8m", "45s" — never "0s", which reads as broken rather than brief. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || ms < 1000) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/**
 * Whether a row is evidence or a claim.
 *
 * `server` rows are derived from events the services emitted while doing the
 * work — a client cannot forge, suppress or inflate them. Everything else is
 * self-reported. The distinction is surfaced in the UI and in the export
 * because it is load-bearing the moment anyone uses this screen to make a
 * decision about a person.
 */
export function sourceLabel(source: ActivitySource): { text: string; verified: boolean } {
  switch (source) {
    case "server":
      return { text: "Verified", verified: true };
    case "desktop":
      return { text: "Desktop app", verified: false };
    case "extension":
      return { text: "Browser extension", verified: false };
    default:
      return { text: "Web app", verified: false };
  }
}

/** Day heading for the timeline: "Today", "Yesterday", then the date. */
export function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}
