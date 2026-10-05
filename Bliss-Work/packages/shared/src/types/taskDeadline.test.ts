import { describe, expect, it } from "vitest";
import { ServerEvent, TaskMissed, EventType } from "./events";
import { AssigneeStatus, ScheduledTaskDTO, SentTaskDTO, StickyTaskDTO } from "./domain";

const id = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

// What task-svc's deadline sweeper puts on the wire (services/task-svc/app/events.py
// task_missed) — the same keys, so a rename on either side fails here.
const missed = {
  type: "task.missed",
  eventId: id(1),
  orgId: id(2),
  occurredAt: "2026-10-01T16:00:03.123Z",
  taskId: id(3),
  assigneeId: id(4),
  senderId: id(5),
  statusVersion: 2,
  assigneeUsername: "carol",
};

describe("task.missed on the wire", () => {
  it("is a ServerEvent the socket will accept, and the right variant", () => {
    const parsed = ServerEvent.parse(missed);
    expect(parsed.type).toBe(EventType.TaskMissed);
    expect(TaskMissed.parse(missed).assigneeUsername).toBe("carol");
  });

  it("is refused without the fields the routing and the toast depend on", () => {
    for (const key of ["assigneeId", "senderId", "statusVersion", "assigneeUsername"] as const) {
      const { [key]: _omitted, ...rest } = missed;
      expect(ServerEvent.safeParse(rest).success).toBe(false);
    }
  });
});

describe("the MISSED status and deadline fields", () => {
  it("MISSED is an assignee status", () => {
    expect(AssigneeStatus.parse("MISSED")).toBe("MISSED");
  });

  const sticky = {
    taskId: id(3), orgId: id(2), title: "t", description: "", senderId: id(5), senderUsername: "s",
    myStatus: "MISSED", actions: [], statusVersion: 2, assignedAt: "2026-10-01T10:00:00Z", acknowledgedAt: null,
  };

  it("a task card DTO carries deadline and missed times, and old servers' DTOs without them still parse", () => {
    const withTimes = StickyTaskDTO.parse({ ...sticky, deadlineAt: "2026-10-01T16:00:00Z", missedAt: "2026-10-01T16:00:03Z" });
    expect(withTimes.deadlineAt).toBe("2026-10-01T16:00:00Z");
    expect(withTimes.missedAt).toBe("2026-10-01T16:00:03Z");
    const legacy = StickyTaskDTO.parse(sticky);
    expect(legacy.deadlineAt).toBeUndefined();
    expect(StickyTaskDTO.parse({ ...sticky, deadlineAt: null }).deadlineAt).toBeNull();
  });

  it("a sent task carries its deadline and each assignee's missed time", () => {
    const parsed = SentTaskDTO.parse({
      taskId: id(3), title: "t", description: "", createdAt: "2026-10-01T10:00:00Z", deadlineAt: "2026-10-01T16:00:00Z",
      assignees: [{ assigneeId: id(4), assigneeUsername: "carol", status: "MISSED", missedAt: "2026-10-01T16:00:03Z" }],
    });
    expect(parsed.deadlineAt).toBe("2026-10-01T16:00:00Z");
    expect(parsed.assignees[0]!.missedAt).toBe("2026-10-01T16:00:03Z");
  });

  const schedule = {
    scheduleId: id(9), title: "t", description: "", channelIds: [], kind: "RECURRING", startAt: "x", nextRunAt: "y",
    weekdays: [], endCondition: "NO_END", occurrenceCount: 0, assignees: [],
  };

  it("a schedule carries a deadline rule, which is absent when there is none", () => {
    const rule = { kind: "RELATIVE", amount: 6, unit: "HOURS", time: null, timeZone: "America/New_York" };
    expect(ScheduledTaskDTO.parse({ ...schedule, deadlineRule: rule }).deadlineRule).toEqual(rule);
    expect(ScheduledTaskDTO.parse({ ...schedule, deadlineRule: null }).deadlineRule).toBeNull();
    expect(ScheduledTaskDTO.parse(schedule).deadlineRule).toBeUndefined();
    expect(ScheduledTaskDTO.safeParse({ ...schedule, deadlineRule: { ...rule, kind: "WEEKLY" } }).success).toBe(false);
  });
});
