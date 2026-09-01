import { describe, it, expect } from "vitest";
import type { AssigneeStatus, StickyTaskDTO } from "../types/domain";
import { canAcceptNewPin, canFloatTask, canPinTask, idsToPrune, selectFloatingTasks, shouldOfferPin } from "./stickyPin";

/** Build a StickyTaskDTO with sane defaults; override what a test cares about. */
function task(over: Partial<StickyTaskDTO> & { taskId: string; myStatus: AssigneeStatus }): StickyTaskDTO {
  return {
    orgId: "00000000-0000-0000-0000-000000000000",
    title: "Task " + over.taskId,
    description: "",
    senderId: "00000000-0000-0000-0000-000000000001",
    senderUsername: "alice",
    actions: [],
    statusVersion: 1,
    assignedAt: "2026-01-01T00:00:00.000Z",
    acknowledgedAt: null,
    ...over,
  };
}

const ALL_STATUSES: AssigneeStatus[] = ["SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT"];

describe("canPinTask", () => {
  it("allows manual-pinning any ACTIONABLE task, not just acknowledged ones", () => {
    expect(canPinTask("ACKNOWLEDGED")).toBe(true);
    // The manual button is the recovery path for a note taken off screen with
    // its X, and a SENT note can be hidden too. Requiring ACKNOWLEDGED meant a
    // freshly-assigned note, once hidden, could not be brought back until the
    // user acknowledged a task they could no longer see.
    expect(canPinTask("SENT")).toBe(true);
  });

  it("rejects every terminal status", () => {
    for (const s of ALL_STATUSES.filter((x) => x !== "ACKNOWLEDGED" && x !== "SENT")) {
      expect(canPinTask(s)).toBe(false);
    }
  });

  it("stays in step with canFloatTask — the button must be offered for anything that floats", () => {
    for (const s of ALL_STATUSES) expect(canPinTask(s)).toBe(canFloatTask(s));
  });
});

describe("canFloatTask", () => {
  it("floats SENT and ACKNOWLEDGED (an allocation pops up on its own)", () => {
    expect(canFloatTask("SENT")).toBe(true);
    expect(canFloatTask("ACKNOWLEDGED")).toBe(true);
  });

  it("never floats a terminal status", () => {
    for (const s of ["IGNORED", "COMPLETED", "LEFT"] as AssigneeStatus[]) {
      expect(canFloatTask(s)).toBe(false);
    }
  });
});

describe("selectFloatingTasks", () => {
  it("floats tasks that are pinned AND still actionable (SENT or ACKNOWLEDGED)", () => {
    const tasks = [
      task({ taskId: "a", myStatus: "ACKNOWLEDGED" }), // pinned + ack -> float
      task({ taskId: "b", myStatus: "SENT" }), // pinned + SENT -> float (auto-pop)
      task({ taskId: "c", myStatus: "ACKNOWLEDGED" }), // ack but NOT pinned -> no
      task({ taskId: "d", myStatus: "COMPLETED" }), // pinned but terminal -> no
    ];
    const out = selectFloatingTasks(tasks, ["a", "b", "d"], 10);
    expect(out.map((t) => t.taskId)).toEqual(["a", "b"]);
  });

  it("floats a SENT task once pinned so a new allocation auto-pops", () => {
    const tasks = [task({ taskId: "s", myStatus: "SENT" })];
    expect(selectFloatingTasks(tasks, ["s"], 10).map((t) => t.taskId)).toEqual(["s"]);
  });

  it("respects the max cap and preserves input order", () => {
    const tasks = ["a", "b", "c", "d"].map((id) => task({ taskId: id, myStatus: "ACKNOWLEDGED" }));
    const out = selectFloatingTasks(tasks, ["a", "b", "c", "d"], 2);
    expect(out.map((t) => t.taskId)).toEqual(["a", "b"]);
  });

  it("treats a negative max as no cap", () => {
    const tasks = ["a", "b", "c"].map((id) => task({ taskId: id, myStatus: "ACKNOWLEDGED" }));
    expect(selectFloatingTasks(tasks, ["a", "b", "c"], -1)).toHaveLength(3);
  });

  it("returns nothing when nothing is pinned", () => {
    const tasks = [task({ taskId: "a", myStatus: "ACKNOWLEDGED" })];
    expect(selectFloatingTasks(tasks, [], 5)).toEqual([]);
  });

  it("accepts a Set as well as an array of pinned ids", () => {
    const tasks = [task({ taskId: "a", myStatus: "ACKNOWLEDGED" })];
    expect(selectFloatingTasks(tasks, new Set(["a"]), 5).map((t) => t.taskId)).toEqual(["a"]);
  });
});

describe("idsToPrune", () => {
  it("prunes pinned ids absent from the live list (completed/left/ignored)", () => {
    expect(idsToPrune(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("keeps pinned ids still present in the live list", () => {
    expect(idsToPrune(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("prunes everything when the live list is empty (all tasks gone)", () => {
    expect(idsToPrune(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("returns nothing when nothing is pinned", () => {
    expect(idsToPrune([], ["a", "b"])).toEqual([]);
  });

  it("accepts Sets for either argument", () => {
    expect(idsToPrune(new Set(["a", "b"]), new Set(["a"]))).toEqual(["b"]);
  });
});

describe("canAcceptNewPin", () => {
  it("accepts while below the cap", () => {
    expect(canAcceptNewPin(0, 5)).toBe(true);
    expect(canAcceptNewPin(4, 5)).toBe(true);
  });

  it("refuses once the cap is reached", () => {
    expect(canAcceptNewPin(5, 5)).toBe(false);
    expect(canAcceptNewPin(6, 5)).toBe(false);
  });
});

describe("shouldOfferPin", () => {
  const base = { status: "ACKNOWLEDGED" as AssigneeStatus, canPinOnPlatform: true, alreadyPinned: false, locked: false };

  it("offers the button for an acknowledged, unpinned task on a pin-capable platform", () => {
    expect(shouldOfferPin(base)).toBe(true);
  });

  it("hides the button on web (no platform support)", () => {
    expect(shouldOfferPin({ ...base, canPinOnPlatform: false })).toBe(false);
  });

  it("hides the button when the task is already pinned", () => {
    expect(shouldOfferPin({ ...base, alreadyPinned: true })).toBe(false);
  });

  it("hides the button when the card is locked", () => {
    expect(shouldOfferPin({ ...base, locked: true })).toBe(false);
  });

  it("offers the button on a SENT task, so a hidden allocation can be brought back", () => {
    expect(shouldOfferPin({ ...base, status: "SENT" })).toBe(true);
  });

  it("hides the button once the task is terminal", () => {
    for (const s of ["COMPLETED", "IGNORED", "LEFT"] as AssigneeStatus[]) {
      expect(shouldOfferPin({ ...base, status: s })).toBe(false);
    }
  });
});
