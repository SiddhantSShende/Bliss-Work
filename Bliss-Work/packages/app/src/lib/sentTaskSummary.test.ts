import { describe, expect, it } from "vitest";
import type { SentAssignee } from "./sentTaskFilter";
import { summarizeSentTask } from "./sentTaskSummary";

const rows = (...s: string[]) => s.map((status) => ({ status })) as unknown as SentAssignee[];

describe("summarizeSentTask", () => {
  it("is pending while nobody has acted, in progress once anyone has", () => {
    expect(summarizeSentTask(rows("SENT", "SENT")).kind).toBe("pending");
    expect(summarizeSentTask(rows("SENT", "ACKNOWLEDGED")).kind).toBe("inProgress");
    expect(summarizeSentTask(rows("COMPLETED", "SENT")).kind).toBe("inProgress");
  });

  it("is completed once somebody completed and nobody is still on it", () => {
    expect(summarizeSentTask(rows("COMPLETED", "LEFT", "MISSED"))).toEqual({ kind: "completed", done: 1, total: 3 });
  });

  it("names the one outcome everybody shares, else closed", () => {
    expect(summarizeSentTask(rows("MISSED", "MISSED")).kind).toBe("missed");
    expect(summarizeSentTask(rows("LEFT")).kind).toBe("left");
    expect(summarizeSentTask(rows("IGNORED")).kind).toBe("ignored");
    expect(summarizeSentTask(rows("LEFT", "IGNORED")).kind).toBe("closed");
    expect(summarizeSentTask(rows()).kind).toBe("closed");
  });
});
