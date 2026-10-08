import { describe, expect, it } from "vitest";
import type { SentTaskDTO } from "@taskboard/shared";
import {
  NO_SENT_FILTER,
  filterSentTasks,
  markedDays,
  personOptions,
  channelMemberIds,
  selectedMemberIds,
  type ChannelMembers,
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

describe("channel selection", () => {
  // alice is in both channels, bob in A only, carol in B only, dan in neither, E is empty.
  const members: ChannelMembers = new Map([
    ["A", ["alice", "bob"]],
    ["B", ["alice", "carol"]],
    ["E", []],
  ]);
  const withChannels = (...ch: string[]) => filter({ channelIds: new Set(ch) });
  const who = (f: SentTaskFilter) => selectedMemberIds(f, members);

  it("one channel selects all of its members", () => {
    expect(who(withChannels("A"))).toEqual(new Set(["alice", "bob"]));
    expect(ids(filterSentTasks(tasks, withChannels("A"), members))).toEqual(["t1", "t3"]);
  });

  it("several channels select the union of their members", () => {
    expect(who(withChannels("A", "B"))).toEqual(new Set(["alice", "bob", "carol"]));
    expect(ids(filterSentTasks(tasks, withChannels("A", "B"), members))).toEqual(["t1", "t2", "t3"]);
  });

  it("a member of two selected channels is counted once", () => {
    expect([...who(withChannels("A", "B"))!].filter((m) => m === "alice")).toHaveLength(1);
  });

  it("deselecting one overlapping channel keeps the member the other still contributes", () => {
    expect(who(withChannels("A", "B"))!.has("alice")).toBe(true);
    const afterUntickA = who(withChannels("B"))!;
    expect(afterUntickA.has("alice")).toBe(true);
    expect(afterUntickA.has("bob")).toBe(false);
  });

  it("explicit people are independent of channels: unioned in, and left alone when channels clear", () => {
    const both = filter({ personIds: new Set(["carol"]), channelIds: new Set(["A"]) });
    expect(who(both)).toEqual(new Set(["carol", "alice", "bob"]));
    // Deselecting the channel removes only what it contributed; carol was ticked by hand.
    expect(who({ ...both, channelIds: new Set() })).toEqual(new Set(["carol"]));
    expect(both.personIds).toEqual(new Set(["carol"]));
  });

  it("an explicit person who is also in a selected channel survives that channel being cleared", () => {
    const both = filter({ personIds: new Set(["alice"]), channelIds: new Set(["A"]) });
    expect(who({ ...both, channelIds: new Set() })).toEqual(new Set(["alice"]));
  });

  it("people alone behave exactly as before, and nothing selected means no restriction", () => {
    expect(who(filter({ personIds: new Set(["bob"]) }))).toEqual(new Set(["bob"]));
    expect(who(NO_SENT_FILTER)).toBeNull();
    expect(ids(filterSentTasks(tasks, filter({ personIds: new Set(["bob", "carol"]) }), members))).toEqual(["t1", "t2"]);
  });

  it("a channel with no members selects nobody — nothing matches", () => {
    expect(who(withChannels("E"))).toEqual(new Set());
    expect(filterSentTasks(tasks, withChannels("E"), members)).toEqual([]);
  });

  it("a channel whose members are still loading is an active restriction: nothing matches yet, never everything", () => {
    // "slow" is absent from the map — requested, no answer yet.
    expect(who(withChannels("slow"))).toEqual(new Set());
    expect(filterSentTasks(tasks, withChannels("slow"), members)).toEqual([]);
    expect(markedDays(tasks, withChannels("slow"), members).size).toBe(0);
    // The explicit people already apply while it loads, and its members join on arrival.
    const f = filter({ personIds: new Set(["bob"]), channelIds: new Set(["slow"]) });
    expect(ids(filterSentTasks(tasks, f, members))).toEqual(["t1"]);
    const arrived: ChannelMembers = new Map([...members, ["slow", ["carol"]]]);
    expect(ids(filterSentTasks(tasks, f, arrived))).toEqual(["t1", "t2"]);
  });

  it("a channel that failed to load (null) stays an active restriction — it never falls back to everything", () => {
    const failed: ChannelMembers = new Map([...members, ["gone", null]]);
    expect(selectedMemberIds(withChannels("gone"), failed)).toEqual(new Set());
    expect(filterSentTasks(tasks, withChannels("gone"), failed)).toEqual([]);
    expect(markedDays(tasks, withChannels("gone"), failed).size).toBe(0);
    // Alongside others it simply contributes nobody: explicit people and loaded channels still apply.
    expect(selectedMemberIds(filter({ personIds: new Set(["bob"]), channelIds: new Set(["gone"]) }), failed)).toEqual(new Set(["bob"]));
    expect(selectedMemberIds(withChannels("A", "gone"), failed)).toEqual(new Set(["alice", "bob"]));
  });

  it("channelMemberIds is only what the ticked channels contribute, never the explicit people", () => {
    const f = filter({ personIds: new Set(["dan"]), channelIds: new Set(["A", "B", "slow"]) });
    expect(channelMemberIds(f, members)).toEqual(new Set(["alice", "bob", "carol"]));
    expect(channelMemberIds(withChannels("A"), members)).toEqual(new Set(["alice", "bob"]));
    expect(channelMemberIds(NO_SENT_FILTER, members)).toEqual(new Set());
  });

  it("marks the calendar for the channel's members only", () => {
    expect(markedDays(tasks, withChannels("B"), members)).toEqual(new Set([dayStart(9, 10), dayStart(9, 11), dayStart(8, 2)]));
    expect(markedDays(tasks, withChannels("E"), members).size).toBe(0);
  });
});
