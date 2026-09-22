import { describe, expect, it } from "vitest";
import type { SentTaskDTO } from "@taskboard/shared";
import {
  NO_SENT_FILTER,
  filterSentTasks,
  markedDays,
  personOptions,
  type SentAssignee,
  type SentTaskFilter,
  type SentTaskMatch,
} from "./sentTaskFilter";

const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).toISOString();
const dayStart = (month: number, day: number) => new Date(2026, month - 1, day).getTime();

function assignee(over: Partial<SentAssignee> & Pick<SentAssignee, "assigneeId">): SentAssignee {
  return { assigneeUsername: over.assigneeId, status: "SENT", assignedAt: at(9, 10), ...over } as SentAssignee;
}
function task(taskId: string, assignees: SentAssignee[]): SentTaskDTO {
  return { taskId, title: taskId, description: "", createdAt: at(9, 1), assignees } as SentTaskDTO;
}
const filter = (over: Partial<SentTaskFilter>): SentTaskFilter => ({ ...NO_SENT_FILTER, ...over });

const alice = assignee({ assigneeId: "alice", status: "COMPLETED", assignedAt: at(9, 10) });
const bob = assignee({ assigneeId: "bob", status: "IGNORED", assignedAt: at(9, 11) });
const carol = assignee({ assigneeId: "carol", status: "SENT", assignedAt: at(9, 11, 23) });
const tasks = [task("t1", [alice, bob]), task("t2", [carol]), task("t3", [assignee({ assigneeId: "alice", status: "LEFT", assignedAt: at(8, 2) })])];
const ids = (ms: SentTaskMatch[]) => ms.map((m) => m.task.taskId);

describe("filterSentTasks", () => {
  it("returns everything, SENT included, when nothing is selected", () => {
    expect(ids(filterSentTasks(tasks, NO_SENT_FILTER))).toEqual(["t1", "t2", "t3"]);
  });

  it("ORs within statuses", () => {
    expect(ids(filterSentTasks(tasks, filter({ statuses: new Set(["IGNORED", "LEFT"]) })))).toEqual(["t1", "t3"]);
  });

  it("ORs within people", () => {
    expect(ids(filterSentTasks(tasks, filter({ personIds: new Set(["bob", "carol"]) })))).toEqual(["t1", "t2"]);
  });

  it("ANDs status, person and day on the same assignee row", () => {
    // alice completed t1 on the 10th; her LEFT row is on 2 Aug, so neither
    // "alice + IGNORED" nor "alice + the 11th" may match anything.
    expect(ids(filterSentTasks(tasks, filter({ personIds: new Set(["alice"]), statuses: new Set(["COMPLETED"]) })))).toEqual(["t1"]);
    expect(filterSentTasks(tasks, filter({ personIds: new Set(["alice"]), statuses: new Set(["IGNORED"]) }))).toEqual([]);
    expect(filterSentTasks(tasks, filter({ personIds: new Set(["alice"]), day: dayStart(9, 11) }))).toEqual([]);
  });

  it("filters by the local day of assignedAt, late evening included", () => {
    expect(ids(filterSentTasks(tasks, filter({ day: dayStart(9, 11) })))).toEqual(["t1", "t2"]);
  });

  it("pairs each task with only its matching rows", () => {
    const [match] = filterSentTasks(tasks, filter({ statuses: new Set(["COMPLETED"]) }));

    expect(match?.assignees).toEqual([alice]);
  });

  it("never copies a DTO: the task and its assignees are the originals, and nothing is mutated", () => {
    const [match] = filterSentTasks(tasks, filter({ statuses: new Set(["COMPLETED"]) }));

    expect(match?.task).toBe(tasks[0]);
    expect(match?.assignees[0]).toBe(alice);
    expect(tasks[0]?.assignees).toEqual([alice, bob]); // the hidden row is still on the task
  });

  it("returns every task with all of its rows when nothing is selected", () => {
    const all = filterSentTasks(tasks, NO_SENT_FILTER);

    expect(all.map((m) => m.task)).toEqual(tasks);
    expect(all[0]?.assignees).toBe(tasks[0]?.assignees);
  });

  it("does not let a task with no assignees pass an active filter", () => {
    expect(filterSentTasks([task("empty", [])], filter({ statuses: new Set(["SENT"]) }))).toEqual([]);
  });
});

describe("markedDays", () => {
  it("marks every day an assignment landed on", () => {
    expect(markedDays(tasks, NO_SENT_FILTER)).toEqual(new Set([dayStart(9, 10), dayStart(9, 11), dayStart(8, 2)]));
  });

  it("respects status and person filters but ignores the selected day", () => {
    const f = filter({ statuses: new Set(["IGNORED"]), day: dayStart(9, 10) });
    expect(markedDays(tasks, f)).toEqual(new Set([dayStart(9, 11)]));
  });

  it("skips assignments whose date can't be parsed", () => {
    const broken = task("t4", [assignee({ assigneeId: "dan", assignedAt: "not-a-date" })]);
    expect(markedDays([broken], NO_SENT_FILTER).size).toBe(0);
  });
});

describe("personOptions", () => {
  it("lists each assignee once, from real task data", () => {
    expect(personOptions(tasks).map((p) => p.id)).toEqual(["alice", "bob", "carol"]);
  });
});
