import { describe, expect, it } from "vitest";
import type { StickyTaskDTO } from "@taskboard/shared";
import { TERMINAL_VIEW_LIMIT, isTerminalView, terminalAt } from "./tasksBuckets";

const t = (over: Partial<StickyTaskDTO>) => ({ assignedAt: "2026-09-01T00:00:00Z", ...over }) as StickyTaskDTO;

describe("terminal (archive) views", () => {
  it("Missed is an archive like Completed, Left and Ignored — and Allocated is not", () => {
    for (const view of ["completed", "left", "ignored", "missed"]) expect(isTerminalView(view)).toBe(true);
    for (const view of ["allocated", "available", "mine"]) expect(isTerminalView(view)).toBe(false);
    expect(TERMINAL_VIEW_LIMIT).toBe(10);
  });

  it("orders a missed task by when it was missed, falling back to when it was assigned", () => {
    expect(terminalAt(t({ missedAt: "2026-09-20T16:00:00Z" }))).toBe("2026-09-20T16:00:00Z");
    expect(terminalAt(t({}))).toBe("2026-09-01T00:00:00Z");
    expect(terminalAt(t({ completedAt: "2026-09-21T00:00:00Z" }))).toBe("2026-09-21T00:00:00Z");
  });
});
