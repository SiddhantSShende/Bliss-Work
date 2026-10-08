/**
 * How the Meetings section decides what it is looking at, and what to call it.
 *
 * The counterpart of lib/mailView: the section is a folder column, a list and a
 * reading pane, and — exactly as in Mail — which folder is open lives in the
 * URL rather than in component state. That is what makes opening a meeting and
 * coming back return to the list the user picked it out of, and what lets the
 * app shell (which renders the folder column) and the list agree without either
 * owning the other.
 */
import type { CallDTO } from "@taskboard/shared";
import i18n from "../i18n";
import { formatDurationCompact } from "../i18n/format";

/** The three buckets a meeting can be in. These ARE the folders. */
export type MeetingBucket = "upcoming" | "live" | "past";

export const MEETING_BUCKETS: readonly { key: MeetingBucket }[] = [
  { key: "upcoming" },
  { key: "live" },
  { key: "past" },
];

/** Localized via the global i18next instance, same as dayLabel.ts — resolved
 *  fresh on every call so it follows the in-app selected locale. */
export function bucketLabel(key: MeetingBucket): string {
  return i18n.t(`meetings:list.bucket.${key}`);
}

const DEFAULT_BUCKET: MeetingBucket = "upcoming";

function isMeetingBucket(v: unknown): v is MeetingBucket {
  return v === "upcoming" || v === "live" || v === "past";
}

/** Which bucket the URL names, defaulting to Upcoming. */
export function bucketOf(params: URLSearchParams): MeetingBucket {
  const v = params.get("view");
  return isMeetingBucket(v) ? v : DEFAULT_BUCKET;
}

/** The search string for a bucket. Built in one place so the folder column and
 *  the back-out-of-the-detail link cannot drift apart. */
export function meetingSearch(bucket: MeetingBucket): string {
  return bucket === DEFAULT_BUCKET ? "" : `?view=${bucket}`;
}

/** Which bucket a call belongs in. The server's status is the authority — a
 *  scheduled time that has passed does NOT make a meeting live, because
 *  somebody still has to open it. */
export function bucketFor(call: CallDTO): MeetingBucket {
  if (call.status === "LIVE") return "live";
  if (call.status === "SCHEDULED") return "upcoming";
  return "past";
}

/** `bucketFor`, except a cancelled call is always "past" rather than whatever
 *  its LIVE/SCHEDULED status would otherwise bucket it as — cancelling a
 *  meeting doesn't retroactively change its status, so the calendar and list
 *  views that draw a cancelled call still need to place it with what's done. */
export function meetingBucketOrPast(call: CallDTO): MeetingBucket {
  return call.status === "CANCELLED" ? "past" : bucketFor(call);
}

/** The short title for a calendar chip/block: the call's own title, or —
 *  untitled — whoever created it, or failing that a plain placeholder. Unlike
 *  `meetingDisplayName`, this never falls back to the participant roster; the
 *  calendar surfaces that use it have no room for a joined-names list. */
export function meetingTitle(call: CallDTO, nameOf: (id: string) => string): string {
  return call.title.trim() || nameOf(call.createdBy) || i18n.t("meetings:view.untitled");
}

/** What kind of call this is, for the one-line "scope" caption under a
 *  meeting's name — null for a plain MEETING, which has no scope worth
 *  naming. */
export function meetingScope(call: CallDTO): string | null {
  if (call.kind === "CHANNEL") return i18n.t("meetings:view.scope.channelCall");
  if (call.kind === "DIRECT") return i18n.t("meetings:view.scope.directCall");
  return null;
}

/** Is this a detail route (a meeting is open in the reading pane)? */
export function isMeetingDetailPath(pathname: string): boolean {
  return /^\/app\/meetings\/[^/]+$/.test(pathname) && !pathname.endsWith("/all");
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the calendar's Filter control narrows by.
 *
 * Both dimensions are fields the server already sends on every row, so nothing
 * here needs a request of its own: `kind` is what SORT of call it is, and
 * `createdBy` is who put it in the diary. An EMPTY `kinds` means "every kind" —
 * not "no kinds" — because a filter nobody has opened must not hide everything.
 */
export interface MeetingFilter {
  kinds: readonly CallDTO["kind"][];
  /** Only meetings this viewer organised. */
  mineOnly: boolean;
}

export const NO_MEETING_FILTER: MeetingFilter = { kinds: [], mineOnly: false };

/** Is anything actually being narrowed? Drives the dot on the Filter button —
 *  a filter that is on and invisible is a list that looks wrong. An explicit
 *  tick on every kind narrows nothing, same as ticking none — both mean
 *  "every kind" per `matchesFilter`, so neither should light the dot. */
export function isFiltering(f: MeetingFilter): boolean {
  const allKindsChosen = f.kinds.length === MEETING_KINDS.length;
  return (f.kinds.length > 0 && !allKindsChosen) || f.mineOnly;
}

export function matchesFilter(
  call: CallDTO,
  f: MeetingFilter,
  viewerId?: string | null,
): boolean {
  if (f.kinds.length > 0 && !f.kinds.includes(call.kind)) return false;
  if (f.mineOnly && call.createdBy !== viewerId) return false;
  return true;
}

/** Every kind a call can be. */
export const MEETING_KINDS = ["MEETING", "CHANNEL", "DIRECT"] as const satisfies readonly CallDTO["kind"][];

/** What each kind is called wherever one is named — the filter menu, a block's
 *  subtitle, a row's scope line. One lookup so they cannot disagree; resolved
 *  per call (not a module constant) so it follows the in-app language. */
export function meetingKindLabel(kind: CallDTO["kind"]): string {
  return i18n.t(`meetings:view.kind.${kind}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming a meeting that was never named
// ─────────────────────────────────────────────────────────────────────────────

/** How many people get named before the rest become "others". */
const NAMED_LIMIT = 2;

/**
 * What to call this meeting.
 *
 * A title if it has one. Otherwise the people in it — "Mayank, Siddhant & 3
 * others" — because an untitled meeting is still perfectly recognisable by who
 * was in it, and "Meeting" repeated down a list is not a list.
 *
 * ── Who counts ───────────────────────────────────────────────────────────────
 * Whoever actually TURNED UP, when anybody did: for a meeting that has happened
 * the honest answer to "which one was that" is the people who were in the room,
 * not the twelve who were invited. Before it happens nobody has joined yet, so
 * the invited roster is all there is and is what gets used.
 *
 * ── Why the viewer is left out ───────────────────────────────────────────────
 * You were in your own meetings. Naming them after yourself tells you nothing
 * and pushes the name that would have told you something into "& 1 other" —
 * the same reason no chat client puts you in a group's name. If you were the
 * only person there, your own name is the only honest answer and is used.
 *
 * `nameOf` comes from useUserLabels, so names are resolved live from the
 * directory rather than from a copy taken when the meeting happened.
 */
export function meetingDisplayName(
  call: CallDTO,
  nameOf: (id: string) => string,
  viewerId?: string | null,
): string {
  const title = call.title.trim();
  if (title) return title;

  const joined = call.participants.filter((p) => p.joinedAt);
  const roster = joined.length > 0 ? joined : call.participants;
  const others = roster.filter((p) => p.userId !== viewerId);
  // Only the viewer was there — then they are the answer.
  const people = others.length > 0 ? others : roster;

  const names = people.map((p) => nameOf(p.userId)).filter(Boolean);
  return joinNames(names);
}

/**
 * "Alice", "Alice & Bob", "Alice, Bob & Carol", "Alice, Bob & 3 others".
 *
 * Three names are spelled out rather than becoming "& 1 other", which is a
 * longer way of saying a shorter thing.
 */
export function joinNames(names: readonly string[]): string {
  const last = names[names.length - 1];
  if (names.length === 0 || last === undefined) return i18n.t("meetings:view.untitled");
  if (names.length === 1) return last;
  const separator = i18n.t("meetings:view.listSeparator");
  if (names.length <= NAMED_LIMIT + 1) {
    return i18n.t("meetings:view.namesAnd", { list: names.slice(0, -1).join(separator), last });
  }
  return i18n.t("meetings:view.namesAndOthers", {
    list: names.slice(0, NAMED_LIMIT).join(separator),
    count: names.length - NAMED_LIMIT,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// How long it ran
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the meeting lasted, in ms, or null when that is not yet a fact.
 *
 * Three different questions wearing one name, and they are kept apart:
 *   PAST      startedAt → endedAt. What actually happened.
 *   LIVE      startedAt → now. Still running, so it is a reading, not a total.
 *   UPCOMING  scheduledAt → endsAt, the PLANNED length, and only when the
 *             organiser named a duration. Nothing is invented for a meeting
 *             that named none.
 */
export function durationMsOf(call: CallDTO, now = Date.now()): number | null {
  const start = call.startedAt ? new Date(call.startedAt).getTime() : null;
  if (call.endedAt && start) {
    return Math.max(0, new Date(call.endedAt).getTime() - start);
  }
  if (call.status === "LIVE" && start) return Math.max(0, now - start);
  if (call.scheduledAt && call.endsAt) {
    return Math.max(0, new Date(call.endsAt).getTime() - new Date(call.scheduledAt).getTime());
  }
  return null;
}

/** "45m", "1h 20m", "2h". Under a minute is "<1m" rather than "0m", which
 *  reads as a meeting that did not happen. */
export function durationLabel(ms: number | null): string {
  if (ms === null) return "—";
  return formatDurationCompact(ms);
}

/** The word for a call's state, in the list and on the detail header. Uses the
 *  bucket rather than the raw status so CANCELLED and ENDED read as one thing
 *  in the places that only care which pile it is in — except that a cancelled
 *  meeting says so, because "Past" would hide that it never happened. */
export function statusLabel(call: CallDTO): string {
  if (call.status === "CANCELLED") return i18n.t("meetings:view.status.cancelled");
  if (call.status === "LIVE") return i18n.t("meetings:view.status.live");
  if (call.status === "SCHEDULED") return i18n.t("meetings:view.status.upcoming");
  return i18n.t("meetings:view.status.ended");
}
