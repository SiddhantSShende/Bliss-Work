import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";
import { actionLabel, activityTitle, collapseSwitches, formatDuration } from "./activityLabels";

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: "e1",
    occurredAt: "2026-01-01T10:00:00.000Z",
    source: "desktop",
    category: "app",
    action: "app.focus",
    surface: null,
    targetKind: "app",
    targetId: "VS Code",
    durationMs: null,
    detail: null,
    ...overrides,
  };
}

describe("actionLabel / switchLabel", () => {
  it("names both ends when the row knows where the person came from", () => {
    const e = entry({ targetId: "VS Code", detail: { from: "BlissWork" } });
    expect(actionLabel(e)).toBe("Switched from BlissWork to VS Code");
  });

  it("falls back to one end when there is no 'from'", () => {
    const e = entry({ targetId: "VS Code", detail: null });
    expect(actionLabel(e)).toBe("Used VS Code");
  });

  it("renders arriving-at-BlissWork as a return, not a switch", () => {
    const e = entry({ targetId: "BlissWork", detail: { from: "youtube.com" } });
    expect(actionLabel(e)).toBe("Came back to BlissWork");
  });

  it("site.visit rows use 'Visited' and resolve the destination name", () => {
    const e = entry({
      action: "site.visit",
      targetKind: "site",
      targetId: "youtube.com",
      detail: null,
    });
    expect(actionLabel(e)).toBe("Visited YouTube");
  });

  it("a row naming no destination at all is not dressed up as one", () => {
    const e = entry({ targetId: null, detail: null });
    expect(actionLabel(e)).toBe("Used something");
  });
});

describe("activityTitle", () => {
  it("returns the title when the row carries one", () => {
    const e = entry({ detail: { title: "activity.go - BlissWork" } });
    expect(activityTitle(e)).toBe("activity.go - BlissWork");
  });

  it("returns null for a row with no title — today's exact behaviour", () => {
    expect(activityTitle(entry({ detail: null }))).toBeNull();
    expect(activityTitle(entry({ detail: { from: "BlissWork" } }))).toBeNull();
  });

  it("treats a blank/whitespace-only title as absent", () => {
    expect(activityTitle(entry({ detail: { title: "   " } }))).toBeNull();
  });
});

describe("collapseSwitches", () => {
  it("drops the web client's blur beside a more specific site.visit for the same switch", () => {
    const blur = entry({
      id: "1",
      source: "web",
      action: "blur",
      occurredAt: "2026-01-01T10:00:00.000Z",
      targetKind: null,
      targetId: null,
      detail: null,
    });
    const site = entry({
      id: "2",
      source: "extension",
      action: "site.visit",
      occurredAt: "2026-01-01T10:00:05.000Z",
      targetKind: "site",
      targetId: "youtube.com",
      detail: { from: "BlissWork" },
    });
    expect(collapseSwitches([site, blur]).map((e) => e.id)).toEqual(["2"]);
  });

  it("prefers a site.visit over the desktop agent's coarser app.focus for a browser", () => {
    const appFocus = entry({
      id: "1",
      source: "desktop",
      action: "app.focus",
      occurredAt: "2026-01-01T10:00:00.000Z",
      targetKind: "app",
      targetId: "Google Chrome",
      detail: null,
    });
    const site = entry({
      id: "2",
      source: "extension",
      action: "site.visit",
      occurredAt: "2026-01-01T10:00:03.000Z",
      targetKind: "site",
      targetId: "youtube.com",
      detail: { from: "BlissWork" },
    });
    expect(collapseSwitches([appFocus, site]).map((e) => e.id)).toEqual(["2"]);
  });

  it("keeps a desktop app.focus for a non-browser app — nothing supersedes it", () => {
    const vscode = entry({
      id: "1",
      source: "desktop",
      action: "app.focus",
      targetKind: "app",
      targetId: "VS Code",
    });
    expect(collapseSwitches([vscode]).map((e) => e.id)).toEqual(["1"]);
  });

  it("keeps two genuine switches minutes apart as two rows", () => {
    const first = entry({
      id: "1",
      action: "app.focus",
      targetId: "VS Code",
      occurredAt: "2026-01-01T10:00:00.000Z",
    });
    const second = entry({
      id: "2",
      action: "app.focus",
      targetId: "Slack",
      occurredAt: "2026-01-01T10:05:00.000Z",
    });
    expect(collapseSwitches([first, second]).map((e) => e.id)).toEqual(["1", "2"]);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(8 * 60_000)).toBe("8m");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
  });

  it("treats sub-second durations as absent rather than '0s'", () => {
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(999)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });
});
