import { describe, expect, it } from "vitest";
import { listSectionOf, railSectionOf, surfaceOf } from "./section";

const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("which rail icon a route lights", () => {
  it.each([
    ["/app/meetings", "meetings"],
    ["/app/meetings/all", "meetings"],
    [`/app/meetings/${CALL}`, "meetings"],
    ["/app/tasks/allocated", "tasks"],
    ["/app/tasks/ignored", "tasks"],
    [`/app/mail/task/${TASK}`, "mail"],
    ["/app/chats", "chats"],
    ["/app/channels/" + CALL, "channels"],
    ["/app/org", "org"],
    ["/app/settings/activity", "settings"],
  ])("%s lights %s", (path, section) => {
    expect(railSectionOf(path)).toBe(section);
  });

  it("a meeting is never classed as Tasks, in the rail, the list pane or telemetry", () => {
    for (const path of ["/app/meetings", `/app/meetings/${CALL}`]) {
      expect(railSectionOf(path)).not.toBe("tasks");
      expect(listSectionOf(path)).toBeNull();
      expect(surfaceOf(path)).toBe("meetings");
    }
  });
});
