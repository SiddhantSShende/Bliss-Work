import { describe, expect, it } from "vitest";
import type { StickyTaskDTO } from "@taskboard/shared";

import { TERMINAL_VIEW_LIMIT, isTerminalView, terminalAt } from "./tasksBuckets";

/**
 * Terminal task buckets show the latest ten, and no more.
 *
 * Completed, Left and Ignored are archives — they only grow — so the interesting
 * rules are which buckets get capped and what "latest" means. Ordering by
 * `assignedAt` is the plausible mistake: a task handed over months ago and
 * finished this morning is the NEWEST thing in Completed, and sorting by when it
 * was assigned buries it under nine older ones nobody has touched.
 */
function task(over: Partial<StickyTaskDTO>): StickyTaskDTO {
  return {
    taskId: "00000000-0000-4000-8000-000000000000",
    orgId: "00000000-0000-4000-8000-000000000001",
    title: "t",
    description: "",
    senderId: "00000000-0000-4000-8000-000000000002",
    senderUsername: "sender",
    myStatus: "COMPLETED",
    actions: [],
    statusVersion: 1,
    assignedAt: "2026-01-01T00:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  } as StickyTaskDTO;
}

describe("which buckets are capped", () => {
  it("caps the three terminal buckets", () => {
    for (const v of ["completed", "left", "ignored"]) {
      expect(isTerminalView(v)).toBe(true);
    }
  });

  it("leaves the active buckets uncapped", () => {
    // Outstanding work: hiding the eleventh item would hide something that
    // still needs doing.
    for (const v of ["mine", "allocated", "available", ""]) {
      expect(isTerminalView(v)).toBe(false);
    }
  });
});

describe("what 'latest' means", () => {
  it("uses the terminal timestamp, not the assignment date", () => {
    const old = task({ assignedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-08-01T00:00:00.000Z" });
    const recentlyAssigned = task({ assignedAt: "2026-07-01T00:00:00.000Z", completedAt: "2026-07-02T00:00:00.000Z" });

    // The task assigned first was FINISHED last, so it sorts first.
    expect(terminalAt(old) > terminalAt(recentlyAssigned)).toBe(true);
  });

  it("reads each bucket's own timestamp", () => {
    expect(terminalAt(task({ leftAt: "2026-05-05T00:00:00.000Z" }))).toBe("2026-05-05T00:00:00.000Z");
    expect(terminalAt(task({ ignoredAt: "2026-06-06T00:00:00.000Z" }))).toBe("2026-06-06T00:00:00.000Z");
  });

  it("falls back to assignedAt when the terminal timestamp is absent", () => {
    // The fields are optional on the DTO. A row from a server that predates
    // them must still sort by something real — sorting as "" would pin it to
    // the bottom regardless of age.
    expect(terminalAt(task({ assignedAt: "2026-02-02T00:00:00.000Z" }))).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("the cap itself", () => {
  it("keeps the ten most recently finished tasks", () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      task({ taskId: `id-${i}`, completedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const shown = [...tasks]
      .sort((a, b) => terminalAt(b).localeCompare(terminalAt(a)))
      .slice(0, TERMINAL_VIEW_LIMIT);

    expect(shown).toHaveLength(10);
    // Newest first, and it is the newest ten — not the first ten the server
    // happened to return.
    expect(shown[0]!.taskId).toBe("id-24");
    expect(shown.at(-1)!.taskId).toBe("id-15");
  });

  it("shows everything when there are fewer than the cap", () => {
    const tasks = [task({ taskId: "a", completedAt: "2026-01-01T00:00:00.000Z" })];
    expect(tasks.slice(0, TERMINAL_VIEW_LIMIT)).toHaveLength(1);
  });
});
