/**
 * The member activity timeline, rendering BROWSER, DESKTOP, and BlissWork-
 * NATIVE (web beacon) activity together on one page — the exact scenario
 * this feature exists for, and the reason `activityTimeline` (raw
 * TimelineEntry rows, every category) and `activitySessionEntries` (the
 * sessionizer's correlated app+site records) are fetched and rendered
 * TOGETHER rather than one replacing the other.
 *
 * Three target-example rows from the task spec, each exercised end to end
 * (durations asserted against `formatDuration`'s REAL, pre-existing output
 * shape — minutes OR seconds, never both once minutes are non-zero — not the
 * task spec's illustrative "13m 24s"/"31m 05s" text):
 *   - "Switched to YouTube / Learn Go in 30 Minutes / 13m [Open]"
 *     (browser extension: a site.visit row correlated with a desktop
 *     app.focus row for Chrome)
 *   - "Switched to VS Code / activity.go - BlissWork / 31m"
 *     (desktop sensor only: an app.focus row with no browser correlation)
 *   - "Switched to GitHub / blisswork/backend / 12m"
 *     (browser + siteEnrichment's siteRef, rendered instead of a title)
 * plus a BlissWork-native row (`route.enter`) and a graceful-degradation row
 * (an app.focus with NO correlated session and NO title at all — the
 * "Switched away from BlissWork"-era rendering that must still work).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivitySessionEntryPage, TimelineEntry, TimelinePage } from "@taskboard/shared";
import { vi } from "vitest";

const api = {
  activityTimeline: vi.fn(),
  activitySessionEntries: vi.fn(),
};

vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

import { MemberTimeline } from "./MemberTimeline";

function renderTimeline(timeline: TimelinePage, sessions: ActivitySessionEntryPage) {
  api.activityTimeline.mockResolvedValue(timeline);
  api.activitySessionEntries.mockResolvedValue(sessions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

function timelineEntry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: "e-default",
    occurredAt: "2026-01-01T15:00:00.000Z",
    source: "desktop",
    category: "app",
    action: "app.focus",
    surface: null,
    targetKind: "app",
    targetId: "Google Chrome",
    durationMs: null,
    detail: null,
    ...over,
  };
}

describe("MemberTimeline: browser, desktop, and BlissWork-native activity together", () => {
  it("renders a browser (YouTube) row with title, duration, and an Open link — sourced from the correlated session", async () => {
    const youtube = timelineEntry({
      id: "e-youtube",
      occurredAt: "2026-01-01T15:00:00.000Z",
      source: "desktop", // the anchor is the DESKTOP app.focus row, per sessionizer.py
      action: "app.focus",
      targetKind: "app",
      targetId: "Google Chrome",
      durationMs: 804_000, // 13m 24s of real time; formatDuration displays "13m"
      detail: { from: "BlissWork" },
    });

    renderTimeline(
      { entries: [youtube], nextCursor: null },
      {
        sessions: [{
          id: "s-youtube",
          kind: "app+site",
          appName: "Google Chrome",
          domain: "youtube.com",
          title: "Learn Go in 30 Minutes",
          startedAt: "2026-01-01T15:00:00.000Z",
          endedAt: "2026-01-01T15:13:24.000Z",
          durationMs: 804_000,
          detail: { url: "youtube.com/watch?v=dQw4w9WgXcQ", siteKind: "video", siteRef: "dQw4w9WgXcQ" },
          // Matched to the rendered row by event id, not by timestamp — see
          // activityLabels.ts's sessionEntryFor doc comment for why. This is
          // the desktop app.focus row, so it's the session's anchor.
          anchorEventId: "e-youtube",
          correlatedEventId: null,
        }],
        nextCursor: null,
      },
    );

    expect(await screen.findByText("Switched from BlissWork to YouTube")).toBeTruthy();
    expect(screen.getByText("Learn Go in 30 Minutes")).toBeTruthy();
    // formatDuration (pre-existing, unchanged) shows minutes OR seconds, never
    // both once minutes are non-zero — "13m", not "13m 24s". See its own doc
    // comment: `"2h 14m", "8m", "45s"`; the task spec's "13m 24s" is
    // illustrative of the CONTEXTUAL RECORD shape, not this app's exact
    // duration format, which this test asserts against reality.
    expect(screen.getByText("13m")).toBeTruthy();
    const link = screen.getByRole("link", { name: /open/i });
    expect(link.getAttribute("href")).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("matches the correlated session by event id even when the surviving row's own clock disagrees with the session's startedAt", async () => {
    // Regression coverage for the audit finding: collapseSwitches keeps the
    // BROWSER row (its own independent occurredAt) over the desktop app.focus
    // row it was merged with, but activity_sessions.startedAt is always the
    // DESKTOP row's timestamp (sessionizer.py's _merged_span). A few seconds
    // of clock skew between the two sensors — normal, since they're two
    // separate processes — used to make the timestamp-keyed lookup miss
    // entirely, silently dropping title/Open-link/siteRef. Both rows are fed
    // in here (as the server actually sends them); only the site row should
    // render, and it must still find its session via correlatedEventId.
    const desktopAnchor = timelineEntry({
      id: "e-desktop-anchor",
      occurredAt: "2026-01-01T20:00:00.000Z", // the session's startedAt
      action: "app.focus",
      targetKind: "app",
      targetId: "Google Chrome",
      detail: { from: "BlissWork" },
    });
    const siteRow = timelineEntry({
      id: "e-site-skewed",
      occurredAt: "2026-01-01T20:00:04.000Z", // browser's own clock — 4s skew
      source: "extension",
      category: "site",
      action: "site.visit",
      targetKind: "site",
      targetId: "youtube.com",
      durationMs: 300_000,
      detail: { from: "BlissWork" },
    });

    renderTimeline(
      { entries: [desktopAnchor, siteRow], nextCursor: null },
      {
        sessions: [{
          id: "s-skewed",
          kind: "app+site",
          appName: "Google Chrome",
          domain: "youtube.com",
          title: "Skew Test Video",
          startedAt: "2026-01-01T20:00:00.000Z", // desktop anchor's time, NOT the site row's
          endedAt: "2026-01-01T20:05:00.000Z",
          durationMs: 300_000,
          detail: { url: "youtube.com/watch?v=skew", siteKind: "video", siteRef: "skew" },
          anchorEventId: "e-desktop-anchor",
          correlatedEventId: "e-site-skewed",
        }],
        nextCursor: null,
      },
    );

    expect(await screen.findByText("Skew Test Video")).toBeTruthy();
    const link = screen.getByRole("link", { name: /open/i });
    expect(link.getAttribute("href")).toBe("https://youtube.com/watch?v=skew");
  });

  it("renders a desktop-only (VS Code) row with a window title and duration, no session, no Open link", async () => {
    const vscode = timelineEntry({
      id: "e-vscode",
      occurredAt: "2026-01-01T16:00:00.000Z",
      action: "app.focus",
      targetKind: "app",
      targetId: "Visual Studio Code",
      durationMs: 1_865_000, // 31m 5s of real time; formatDuration displays "31m"
      detail: { from: "Google Chrome", title: "activity.go - BlissWork" },
    });

    renderTimeline(
      { entries: [vscode], nextCursor: null },
      {
        sessions: [{
          id: "s-vscode",
          kind: "app",
          appName: "Visual Studio Code",
          domain: null,
          title: "activity.go - BlissWork",
          startedAt: "2026-01-01T16:00:00.000Z",
          endedAt: "2026-01-01T16:31:05.000Z",
          durationMs: 1_865_000,
          detail: { from: "Google Chrome" },
          anchorEventId: "e-vscode",
          correlatedEventId: null,
        }],
        nextCursor: null,
      },
    );

    expect(await screen.findByText("Switched from Google Chrome to VS Code")).toBeTruthy();
    expect(screen.getByText("activity.go - BlissWork")).toBeTruthy();
    expect(screen.getByText("31m")).toBeTruthy(); // see the YouTube test's note on formatDuration's real output shape
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });

  it("renders a browser (GitHub) row with the correlated siteRef instead of a title", async () => {
    const github = timelineEntry({
      id: "e-github",
      occurredAt: "2026-01-01T17:00:00.000Z",
      targetKind: "app",
      targetId: "Google Chrome",
      durationMs: 720_000, // 12m
      detail: { from: "BlissWork" },
    });

    renderTimeline(
      { entries: [github], nextCursor: null },
      {
        sessions: [{
          id: "s-github",
          kind: "app+site",
          appName: "Google Chrome",
          domain: "github.com",
          title: null, // GitHub's <title> is not what should show — siteRef is
          startedAt: "2026-01-01T17:00:00.000Z",
          endedAt: "2026-01-01T17:12:00.000Z",
          durationMs: 720_000,
          detail: { url: "github.com/blisswork/backend", siteKind: "repository", siteRef: "blisswork/backend" },
          anchorEventId: "e-github",
          correlatedEventId: null,
        }],
        nextCursor: null,
      },
    );

    expect(await screen.findByText("Switched from BlissWork to GitHub")).toBeTruthy();
    expect(screen.getByText("blisswork/backend")).toBeTruthy();
    expect(screen.getByText("12m")).toBeTruthy();
  });

  it("renders BlissWork-native activity (route.enter) unchanged, alongside browser/desktop rows", async () => {
    const nativeRow = timelineEntry({
      id: "e-native",
      occurredAt: "2026-01-01T18:00:00.000Z",
      source: "web",
      category: "navigation",
      action: "route.enter",
      surface: "tasks",
      targetKind: null,
      targetId: null,
      durationMs: null,
      detail: null,
    });

    renderTimeline(
      { entries: [nativeRow], nextCursor: null },
      { sessions: [], nextCursor: null },
    );

    expect(await screen.findByText("Opened Tasks")).toBeTruthy();
    // A navigation row has no session to correlate with and must not show
    // any of the app/site-only affordances.
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });

  it("falls back gracefully to the pre-session rendering when no correlated session exists for a row", async () => {
    // This is the "Switched away from BlissWork"-era case, still exercised:
    // a `blur` row with no destination at all, and NO activity_sessions
    // entry (the sessionizer only covers app/site categories).
    const blur = timelineEntry({
      id: "e-blur",
      source: "web",
      category: "navigation",
      action: "blur",
      targetKind: null,
      targetId: null,
      detail: null,
    });

    renderTimeline(
      { entries: [blur], nextCursor: null },
      { sessions: [], nextCursor: null },
    );

    expect(await screen.findByText("Switched away from BlissWork")).toBeTruthy();
  });

  it("does not fabricate a title, URL, or duration when the row genuinely has none", async () => {
    const bare = timelineEntry({
      id: "e-bare",
      action: "app.focus",
      targetKind: "app",
      targetId: "Slack",
      durationMs: null, // too short to have a meaningful duration, or never closed
      detail: null,
    });

    renderTimeline(
      { entries: [bare], nextCursor: null },
      { sessions: [], nextCursor: null },
    );

    expect(await screen.findByText("Used Slack")).toBeTruthy();
    // No fabricated duration badge, no Open link, no title/enrichment line.
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });

  it("renders all four kinds together on one page, in the order the server returned them", async () => {
    const rows: TimelineEntry[] = [
      timelineEntry({
        id: "1", occurredAt: "2026-01-01T18:00:00.000Z", source: "web",
        category: "navigation", action: "route.enter", surface: "tasks",
        targetKind: null, targetId: null, detail: null,
      }),
      timelineEntry({
        id: "2", occurredAt: "2026-01-01T17:00:00.000Z",
        targetKind: "app", targetId: "Google Chrome", durationMs: 720_000,
        detail: { from: "BlissWork" },
      }),
      timelineEntry({
        id: "3", occurredAt: "2026-01-01T16:00:00.000Z",
        action: "app.focus", targetKind: "app", targetId: "Visual Studio Code",
        durationMs: 1_865_000, detail: { from: "Google Chrome" },
      }),
    ];
    renderTimeline(
      { entries: rows, nextCursor: null },
      {
        sessions: [
          {
            id: "s2", kind: "app+site", appName: "Google Chrome", domain: "github.com",
            title: null, startedAt: "2026-01-01T17:00:00.000Z", endedAt: "2026-01-01T17:12:00.000Z",
            durationMs: 720_000, detail: { siteRef: "blisswork/backend", siteKind: "repository" },
            anchorEventId: "2", correlatedEventId: null,
          },
        ],
        nextCursor: null,
      },
    );

    expect(await screen.findByText("Opened Tasks")).toBeTruthy();
    expect(screen.getByText("Switched from BlissWork to GitHub")).toBeTruthy();
    expect(screen.getByText("blisswork/backend")).toBeTruthy();
    expect(screen.getByText("Switched from Google Chrome to VS Code")).toBeTruthy();
  });
});
