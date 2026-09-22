import type { SentTaskDTO } from "@taskboard/shared";
import { startOfDay } from "./dayLabel";

export type SentAssignee = SentTaskDTO["assignees"][number];
type AssigneeStatus = SentAssignee["status"];

/** The four statuses My Tasks offers as filters. SENT (allocated, not yet
 *  acknowledged) has no chip: it is shown whenever no status is selected. */
export const STATUS_FILTERS: readonly AssigneeStatus[] = ["COMPLETED", "ACKNOWLEDGED", "LEFT", "IGNORED"];

export interface SentTaskFilter {
  /** OR within the set; empty = every status, SENT included. */
  statuses: ReadonlySet<AssigneeStatus>;
  /** OR within the set, by assigneeId; empty = everyone. */
  personIds: ReadonlySet<string>;
  /** Local start-of-day the assignment must fall on; null = any day. */
  day: number | null;
}

export const NO_SENT_FILTER: SentTaskFilter = { statuses: new Set(), personIds: new Set(), day: null };

export function isFiltering(f: SentTaskFilter): boolean {
  return f.statuses.size > 0 || f.personIds.size > 0 || f.day !== null;
}

/** The calendar day an assignment sits on — `assignedAt`, the only timestamp
 *  every assignment has (tasks carry no due or scheduled date). NaN if unparseable. */
function assignedDay(a: SentAssignee): number {
  return a.assignedAt ? startOfDay(Date.parse(a.assignedAt)) : NaN;
}

function matchesStatusAndPerson(a: SentAssignee, f: SentTaskFilter): boolean {
  return (
    (f.statuses.size === 0 || f.statuses.has(a.status)) &&
    (f.personIds.size === 0 || f.personIds.has(a.assigneeId))
  );
}

function matches(a: SentAssignee, f: SentTaskFilter): boolean {
  return matchesStatusAndPerson(a, f) && (f.day === null || assignedDay(a) === f.day);
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
export function filterSentTasks(tasks: readonly SentTaskDTO[], f: SentTaskFilter): SentTaskMatch[] {
  if (!isFiltering(f)) return tasks.map((task) => ({ task, assignees: task.assignees }));
  const out: SentTaskMatch[] = [];
  for (const task of tasks) {
    const assignees = task.assignees.filter((a) => matches(a, f));
    if (assignees.length > 0) out.push({ task, assignees });
  }
  return out;
}

/** Days the calendar should mark: where an assignment matching the status and
 *  person filters lands. The day filter itself is ignored so the selected day
 *  doesn't erase every other mark. */
export function markedDays(tasks: readonly SentTaskDTO[], f: SentTaskFilter): Set<number> {
  const days = new Set<number>();
  for (const t of tasks)
    for (const a of t.assignees) {
      if (!matchesStatusAndPerson(a, f)) continue;
      const day = assignedDay(a);
      if (!Number.isNaN(day)) days.add(day);
    }
  return days;
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
