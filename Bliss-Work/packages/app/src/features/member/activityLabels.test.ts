import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";
import { actionLabel } from "./activityLabels";

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  id: "1",
  occurredAt: "2026-01-05T10:00:00Z",
  source: "desktop",
  category: "app",
  action: "app.focus",
  surface: null,
  targetKind: "app",
  targetId: "chrome.exe",
  durationMs: 60_000,
  detail: null,
  ...over,
});

describe("desktop activity labels", () => {
  it("names the application an app span was in, by its proper name", () => {
    expect(actionLabel(entry({}))).toBe("Used Google Chrome");
    expect(actionLabel(entry({ targetId: "code.exe" }))).toBe("Used Visual Studio Code");
  });

  it("falls back to a readable name for an application it does not know", () => {
    expect(actionLabel(entry({ targetId: "WindowsTerminalPreview.exe" }))).toBe("Used Windows Terminal Preview");
  });

  it("leaves the stored target as the raw executable name", () => {
    const e = entry({});
    actionLabel(e);
    expect(e.targetId).toBe("chrome.exe");
  });

  it("does not print 'undefined' for an app span with no target", () => {
    expect(actionLabel(entry({ targetId: null }))).toBe("Used");
  });

  it("reads an OS idle span distinctly from the web client's in-window idle", () => {
    expect(actionLabel(entry({ action: "os.idle", category: "engagement", targetId: null }))).toBe("Away from keyboard");
    expect(actionLabel(entry({ action: "idle.start", targetId: null }))).toBe("Went idle");
  });
});
