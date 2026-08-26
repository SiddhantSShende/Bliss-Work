import { describe, expect, it } from "vitest";
import type { ActivitySessionEntryDTO, TimelineEntry } from "@taskboard/shared";
import {
  actionLabel,
  activityTitle,
  activityUrl,
  collapseSwitches,
  formatDuration,
  indexSessionEntries,
  sessionEntryFor,
  siteContext,
} from "./activityLabels";

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

function sessionEntry(overrides: Partial<ActivitySessionEntryDTO> = {}): ActivitySessionEntryDTO {
  return {
    id: "s1",
    kind: "app+site",
    appName: "Google Chrome",
    domain: "youtube.com",
    title: "Learn Go in 30 Minutes",
    startedAt: "2026-01-01T10:00:00.000Z",
    endedAt: "2026-01-01T10:14:00.000Z",
    durationMs: 840_000,
    detail: { url: "youtube.com/watch?v=dQw4w9WgXcQ", siteKind: "video", siteRef: "dQw4w9WgXcQ" },
    anchorEventId: "e1",
    correlatedEventId: null,
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

describe("indexSessionEntries / sessionEntryFor", () => {
  it("matches a row to its correlated session by anchorEventId", () => {
    const s = sessionEntry({ anchorEventId: "e1", correlatedEventId: null });
    const index = indexSessionEntries([s]);
    const e = entry({ id: "e1", action: "app.focus" });
    expect(sessionEntryFor(e, index)).toBe(s);
  });

  it("matches the SITE row too, via correlatedEventId — immune to clock skew between sensors", () => {
    // The exact bug this test guards against: the desktop app.focus row (e1,
    // 10:00:00) is the session's anchor, but collapseSwitches prefers the
    // site.visit row (e2) for display, and e2's own occurredAt (10:00:03) is
    // the browser's independent clock reading — a few seconds off from the
    // desktop anchor's timestamp. A timestamp-keyed index would miss this;
    // an event-id-keyed one must not.
    const s = sessionEntry({ anchorEventId: "e1", correlatedEventId: "e2", startedAt: "2026-01-01T10:00:00.000Z" });
    const index = indexSessionEntries([s]);
    const site = entry({ id: "e2", action: "site.visit", occurredAt: "2026-01-01T10:00:03.000Z" });
    expect(sessionEntryFor(site, index)).toBe(s);
  });

  it("does not match a row whose id isn't the session's anchor or correlated id", () => {
    const s = sessionEntry({ anchorEventId: "e1", correlatedEventId: null });
    const index = indexSessionEntries([s]);
    const e = entry({ id: "e-other", action: "app.focus" });
    expect(sessionEntryFor(e, index)).toBeNull();
  });

  it("returns null for a category activity_sessions does not cover", () => {
    const s = sessionEntry({ anchorEventId: "e1" });
    const index = indexSessionEntries([s]);
    const login = entry({ id: "e1", action: "login", category: "auth" });
    expect(sessionEntryFor(login, index)).toBeNull();
  });

  it("returns null when the index is undefined (query not yet loaded)", () => {
    const e = entry({ action: "app.focus" });
    expect(sessionEntryFor(e, undefined)).toBeNull();
  });

  it("returns null when no session was recorded for this row — the fallback path", () => {
    const index = indexSessionEntries([]);
    const e = entry({ id: "e-unrecorded", action: "site.visit" });
    expect(sessionEntryFor(e, index)).toBeNull();
  });
});

describe("actionLabel with a correlated session — Chrome refines to YouTube", () => {
  it("uses the session's domain instead of the desktop-only app name", () => {
    // The row itself only knows "Google Chrome" (a desktop app.focus row);
    // the session record is what actually says "youtube.com".
    const e = entry({
      action: "app.focus", targetKind: "app", targetId: "Google Chrome",
      detail: { from: "BlissWork" },
    });
    const session = sessionEntry({ domain: "youtube.com" });
    expect(actionLabel(e, session)).toBe("Switched from BlissWork to YouTube");
  });

  it("falls back to the row's own destination when the session has no domain (app-only session)", () => {
    const e = entry({
      action: "app.focus", targetKind: "app", targetId: "Visual Studio Code",
      detail: { from: "Google Chrome" },
    });
    const session = sessionEntry({ kind: "app", appName: "Visual Studio Code", domain: null });
    expect(actionLabel(e, session)).toBe("Switched from Google Chrome to VS Code");
  });

  it("falls back to the row's own destination when there is no session at all", () => {
    const e = entry({ action: "app.focus", targetId: "Slack", detail: null });
    expect(actionLabel(e, null)).toBe(actionLabel(e));
  });

  it("never fabricates a destination the session did not actually name", () => {
    // A session with domain: null must not somehow produce a destination —
    // this is the "do not fabricate" requirement pinned as a regression test.
    const e = entry({ action: "app.focus", targetId: null, detail: null });
    const session = sessionEntry({ domain: null, appName: null });
    expect(actionLabel(e, session)).toBe("Used something");
  });
});

describe("activityTitle with a correlated session", () => {
  it("prefers the session's title over the row's own detail.title", () => {
    const e = entry({ action: "site.visit", detail: { title: "stale placeholder" } });
    const session = sessionEntry({ title: "Learn Go in 30 Minutes" });
    expect(activityTitle(e, session)).toBe("Learn Go in 30 Minutes");
  });

  it("falls back to the row's own title when the session has none", () => {
    const e = entry({ action: "site.visit", detail: { title: "row title" } });
    const session = sessionEntry({ title: null });
    expect(activityTitle(e, session)).toBe("row title");
  });

  it("falls back to the row's own title when there is no session", () => {
    const e = entry({ action: "site.visit", detail: { title: "row title" } });
    expect(activityTitle(e, null)).toBe("row title");
  });
});

describe("siteContext", () => {
  it("returns the correlated siteRef — the GitHub repo example", () => {
    const session = sessionEntry({ detail: { siteRef: "blisswork/backend", siteKind: "repository" } });
    expect(siteContext(session)).toBe("blisswork/backend");
  });

  it("returns null when the session has no siteRef — most sites have none", () => {
    const session = sessionEntry({ detail: {} });
    expect(siteContext(session)).toBeNull();
  });

  it("returns null when there is no session at all", () => {
    expect(siteContext(null)).toBeNull();
    expect(siteContext(undefined)).toBeNull();
  });

  it("never invents a siteRef from a title or domain", () => {
    // A session with a rich title/domain but genuinely no siteRef (an
    // unrecognised site) must render nothing here, not derive one.
    const session = sessionEntry({
      domain: "example.com", title: "Some Page", detail: { url: "example.com/x" },
    });
    expect(siteContext(session)).toBeNull();
  });
});

describe("activityUrl", () => {
  it("builds a clickable https URL from the recorded domain+path detail.url", () => {
    const e = entry({
      action: "site.visit",
      detail: { url: "youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    expect(activityUrl(e)).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("prefers the session's url over the row's own", () => {
    const e = entry({ action: "site.visit", detail: { url: "old.example.com/x" } });
    const session = sessionEntry({ detail: { url: "youtube.com/watch?v=1" } });
    expect(activityUrl(e, session)).toBe("https://youtube.com/watch?v=1");
  });

  it("returns null when no url was recorded — never fabricated from targetId/domain", () => {
    const e = entry({ action: "app.focus", targetId: "Google Chrome", detail: null });
    expect(activityUrl(e)).toBeNull();
  });

  it("rejects a non-http(s) scheme rather than rendering a dangerous link", () => {
    const e = entry({ action: "site.visit", detail: { url: "javascript:alert(1)" } });
    expect(activityUrl(e)).toBeNull();
  });

  it("rejects a malformed url string, failing closed to no link", () => {
    const e = entry({ action: "site.visit", detail: { url: "not a url at all :://" } });
    expect(activityUrl(e)).toBeNull();
  });

  it("builds a URL from detail.url regardless of action — callers gate on action, not this function", () => {
    // Matches activityTitle's own documented convention: "only meaningful
    // beside app.focus/site.visit... this does not guard against it." The
    // real gate lives in MemberTimeline.tsx's Row (`isSwitch ? activityUrl(...) : null`).
    const e = entry({ action: "login", category: "auth", detail: { url: "example.com" } });
    // The URL constructor normalises a bare domain with a trailing slash.
    expect(activityUrl(e)).toBe("https://example.com/");
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
