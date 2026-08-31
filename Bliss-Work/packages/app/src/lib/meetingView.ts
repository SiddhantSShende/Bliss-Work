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

/** The three buckets a meeting can be in. These ARE the folders. */
export type MeetingBucket = "upcoming" | "live" | "past";

export const MEETING_BUCKETS: readonly { key: MeetingBucket; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "live", label: "Live" },
  { key: "past", label: "Past" },
];

const DEFAULT_BUCKET: MeetingBucket = "upcoming";

export function isMeetingBucket(v: unknown): v is MeetingBucket {
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

/** Is this a detail route (a meeting is open in the reading pane)? */
export function isMeetingDetailPath(pathname: string): boolean {
  return /^\/app\/meetings\/[^/]+$/.test(pathname) && !pathname.endsWith("/all");
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
  if (names.length === 0 || last === undefined) return "Untitled meeting";
  if (names.length === 1) return last;
  if (names.length <= NAMED_LIMIT + 1) {
    return `${names.slice(0, -1).join(", ")} & ${last}`;
  }
  const rest = names.length - NAMED_LIMIT;
  return `${names.slice(0, NAMED_LIMIT).join(", ")} & ${rest} others`;
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
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** The word for a call's state, in the list and on the detail header. Uses the
 *  bucket rather than the raw status so CANCELLED and ENDED read as one thing
 *  in the places that only care which pile it is in — except that a cancelled
 *  meeting says so, because "Past" would hide that it never happened. */
export function statusLabel(call: CallDTO): string {
  if (call.status === "CANCELLED") return "Cancelled";
  if (call.status === "LIVE") return "Live";
  if (call.status === "SCHEDULED") return "Upcoming";
  return "Ended";
}
