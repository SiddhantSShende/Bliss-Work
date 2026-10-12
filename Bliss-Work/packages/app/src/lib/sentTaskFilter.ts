import type { SentTaskDTO } from "@taskboard/shared";
import { startOfDay } from "./dayLabel";

export type SentAssignee = SentTaskDTO["assignees"][number];
type AssigneeStatus = SentAssignee["status"];
export type SentStatus = AssigneeStatus | "SCHEDULED";

/** The statuses My Tasks offers as filters. SENT (allocated, not yet
 *  acknowledged) has no chip: it is shown whenever no status is selected. */
export const STATUS_FILTERS: readonly SentStatus[] = ["COMPLETED", "ACKNOWLEDGED", "LEFT", "IGNORED", "MISSED", "SCHEDULED"];

export interface SentTaskFilter {
  /** OR within the set; empty = every status, SENT included. */
  statuses: ReadonlySet<SentStatus>;
  /** OR within the set, by assigneeId; empty = everyone. */
  personIds: ReadonlySet<string>;
  /** The channels ticked in the filter. Each stands for ALL of its members (see
   *  `selectedMemberIds`); this set never writes into `personIds`. */
  channelIds: ReadonlySet<string>;
  /** Local start-of-day the assignment must fall on; null = any day. */
  day: number | null;
}

export const NO_SENT_FILTER: SentTaskFilter = { statuses: new Set(), personIds: new Set(), channelIds: new Set(), day: null };

export function isFiltering(f: SentTaskFilter): boolean {
  return f.statuses.size > 0 || f.personIds.size > 0 || f.channelIds.size > 0 || f.day !== null;
}

/** What is known about each ticked channel's members, by channel id:
 *  - an array: loaded;
 *  - absent: still loading — the channel is already an ACTIVE restriction that just
 *    has no members yet, so nothing matches until they arrive (never "everything");
 *  - null: could not be loaded (request failed, or the channel is gone). Still an
 *    ACTIVE restriction, exactly like loading — a channel that is ticked in the UI
 *    must never silently stop filtering — and flagged so the UI can offer a retry. */
export type ChannelMembers = ReadonlyMap<string, readonly string[] | null>;

const NO_CHANNEL_MEMBERS: ChannelMembers = new Map();

/** Everyone the ticked channels contribute so far — loaded ones only. Never includes
 *  the explicit people, which is what lets the People list tell the two apart. */
export function channelMemberIds(f: SentTaskFilter, members: ChannelMembers): Set<string> {
  const out = new Set<string>();
  for (const id of f.channelIds) for (const m of members.get(id) ?? []) out.add(m);
  return out;
}

/**
 * Who the filter selects: the people ticked explicitly UNION every member of every
 * ticked channel (a Set, so someone in two channels counts once). Derived on every
 * call from the two selections, so unticking a channel drops only what that channel
 * alone contributed. null = no person restriction (nothing ticked); an empty set
 * = something is ticked but selects nobody yet (a channel with no members, or whose
 * members are still loading, or failed to load), so nothing matches. A ticked channel
 * is never left out of the restriction, whatever state its members are in.
 */
export function selectedMemberIds(f: SentTaskFilter, members: ChannelMembers): ReadonlySet<string> | null {
  if (f.personIds.size === 0 && f.channelIds.size === 0) return null;
  return new Set([...f.personIds, ...channelMemberIds(f, members)]);
}

/** The calendar day an assignment sits on — `assignedAt`, the only timestamp
 *  every assignment has (tasks carry no due or scheduled date). NaN if unparseable. */
function assignedDay(a: SentAssignee): number {
  return a.assignedAt ? startOfDay(Date.parse(a.assignedAt)) : NaN;
}

function matchesStatusAndPerson(a: SentAssignee, f: SentTaskFilter, who: ReadonlySet<string> | null): boolean {
  return (f.statuses.size === 0 || f.statuses.has(a.status)) && (who === null || who.has(a.assigneeId));
}

function matches(a: SentAssignee, f: SentTaskFilter, who: ReadonlySet<string> | null): boolean {
  return matchesStatusAndPerson(a, f, who) && (f.day === null || assignedDay(a) === f.day);
}

/** A task that passed the filter, with the assignee rows that matched it. `task`
 *  and every assignee are the original DTO objects, never copies — the review
 *  dialog reads live review fields off them. */
export interface SentTaskMatch {
  task: SentTaskDTO;
  assignees: readonly SentAssignee[];
}

/**
 * Tasks with at least one matching assignee, each paired with only its matching
 * rows so a filtered card never shows someone the filter excluded. Unfiltered,
 * every task is returned with all of its rows.
 */
export function filterSentTasks(
  tasks: readonly SentTaskDTO[],
  f: SentTaskFilter,
  members: ChannelMembers = NO_CHANNEL_MEMBERS,
): SentTaskMatch[] {
  if (!isFiltering(f)) return tasks.map((task) => ({ task, assignees: task.assignees }));
  const who = selectedMemberIds(f, members);
  const out: SentTaskMatch[] = [];
  for (const task of tasks) {
    const assignees = task.assignees.filter((a) => matches(a, f, who));
    if (assignees.length > 0) out.push({ task, assignees });
  }
  return out;
}

/** Days the calendar should mark: where an assignment matching the status and
 *  person filters lands. The day filter itself is ignored so the selected day
 *  doesn't erase every other mark. */
export function markedDays(
  tasks: readonly SentTaskDTO[],
  f: SentTaskFilter,
  members: ChannelMembers = NO_CHANNEL_MEMBERS,
): Set<number> {
  const who = selectedMemberIds(f, members);
  const days = new Set<number>();
  for (const t of tasks)
    for (const a of t.assignees) {
      if (!matchesStatusAndPerson(a, f, who)) continue;
      const day = assignedDay(a);
      if (!Number.isNaN(day)) days.add(day);
    }
  return days;
}

/**
 * A sent task is eligible for "Reassign" — the same rule task-svc applies to
 * `POST /tasks/{id}/reassign` — when nobody is still active on it, AND either
 * somebody completed it (a mix of completed with LEFT/IGNORED/MISSED still
 * qualifies: only the completed rows come back) OR every assignee shares the
 * same LEFT or IGNORED outcome (the whole task is handed back to all of them).
 * MISSED alone, or any other mix, has nothing to reassign. Judged on ALL of the
 * task's rows, never a filtered subset.
 */
export function isReassignableTask(task: Pick<SentTaskDTO, "assignees">): boolean {
  const { assignees } = task;
  if (assignees.some((a) => a.status === "SENT" || a.status === "ACKNOWLEDGED")) return false;
  if (assignees.some((a) => a.status === "COMPLETED")) return true;
  const first = assignees[0]?.status;
  return assignees.length > 0 && assignees.every((a) => a.status === first) && (first === "LEFT" || first === "IGNORED");
}

export interface PersonOption {
  id: string;
  /** The DTO's own label (email local-part; may be ""), used until a real name resolves. */
  username: string;
}

/** Everyone a loaded task was allotted to, first-seen order. */
export function personOptions(tasks: readonly SentTaskDTO[]): PersonOption[] {
  const seen = new Map<string, PersonOption>();
  for (const t of tasks)
    for (const a of t.assignees)
      if (!seen.has(a.assigneeId)) seen.set(a.assigneeId, { id: a.assigneeId, username: a.assigneeUsername });
  return [...seen.values()];
}
