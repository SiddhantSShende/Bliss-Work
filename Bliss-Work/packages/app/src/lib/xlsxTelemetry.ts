/**
 * .xlsx builders for the member activity record.
 *
 * Two shapes, one builder underneath:
 *   * all members  — a Summary sheet (one row per person) plus a Daily sheet
 *                    (one row per person per day), which is what someone
 *                    actually pivots on.
 *   * one member   — the same Daily rows for that person, plus their sessions.
 *
 * Rows arrive from telemetry-svc carrying user IDS ONLY — that service stores no
 * names — so every name and email here is joined from the org directory the
 * client already holds. Departed members still resolve because the admin fetches
 * the directory with `includeInactive`.
 */
import type { ActivityExportRow, ActivitySessionDTO, UserDTO } from "@taskboard/shared";
import { fmtDurationMs, fmtLocal, hoursOf, localTimeZone } from "./xlsx/format";
import { buildAndDownload, type SheetSpec } from "./xlsx/workbook";

interface Person {
  name: string;
  email: string;
}

function directoryIndex(directory: UserDTO[]): Map<string, Person> {
  return new Map(directory.map((u) => [u.id, { name: u.displayName, email: u.email }]));
}

function dailyColumns(tz: string) {
  return [
    { header: "Member", key: "name", width: 24 },
    { header: "Email", key: "email", width: 28 },
    { header: "Day", key: "day", width: 12 },
    { header: "Active", key: "active", width: 12 },
    { header: "Active (hours)", key: "activeHours", width: 14 },
    { header: "Idle", key: "idle", width: 12 },
    { header: "Signed in", key: "online", width: 12 },
    { header: "Sessions", key: "sessions", width: 10 },
    { header: "Actions", key: "events", width: 10 },
    { header: `First seen (${tz})`, key: "firstSeen", width: 24 },
    { header: `Last seen (${tz})`, key: "lastSeen", width: 24 },
    { header: "Top section", key: "topSurface", width: 16 },
  ];
}

function dailyRows(rows: ActivityExportRow[], people: Map<string, Person>) {
  return rows.map((r) => {
    const p = people.get(r.userId);
    return {
      name: p?.name || r.userId,
      email: p?.email ?? "",
      day: r.day,
      active: fmtDurationMs(r.activeMs),
      // Both a readable duration and a numeric one: the string is what a person
      // reads, the number is what a pivot table can sum.
      activeHours: hoursOf(r.activeMs),
      idle: fmtDurationMs(r.idleMs),
      online: fmtDurationMs(r.onlineMs),
      sessions: r.sessions,
      events: r.events,
      firstSeen: fmtLocal(r.firstSeenAt),
      lastSeen: fmtLocal(r.lastSeenAt),
      topSurface: r.topSurface ?? "",
    };
  });
}

/** Per-person totals across the whole range — the sheet most people open first. */
function summarySheet(rows: ActivityExportRow[], people: Map<string, Person>): SheetSpec {
  const totals = new Map<string, ActivityExportRow & { days: number }>();
  for (const r of rows) {
    const cur = totals.get(r.userId);
    if (!cur) {
      totals.set(r.userId, { ...r, days: r.activeMs > 0 ? 1 : 0 });
      continue;
    }
    cur.activeMs += r.activeMs;
    cur.idleMs += r.idleMs;
    cur.onlineMs += r.onlineMs;
    cur.sessions += r.sessions;
    cur.events += r.events;
    if (r.activeMs > 0) cur.days += 1;
    // Rows arrive newest-first, so the FIRST row seen holds the latest activity
    // and the last one seen holds the earliest.
    cur.firstSeenAt = r.firstSeenAt ?? cur.firstSeenAt;
  }

  return {
    name: "Summary",
    columns: [
      { header: "Member", key: "name", width: 24 },
      { header: "Email", key: "email", width: 28 },
      { header: "Active", key: "active", width: 14 },
      { header: "Active (hours)", key: "activeHours", width: 14 },
      { header: "Idle", key: "idle", width: 12 },
      { header: "Days active", key: "days", width: 12 },
      { header: "Avg per active day", key: "avg", width: 18 },
      { header: "Sessions", key: "sessions", width: 10 },
      { header: "Actions", key: "events", width: 10 },
    ],
    rows: [...totals.values()]
      .sort((a, b) => b.activeMs - a.activeMs)
      .map((t) => {
        const p = people.get(t.userId);
        return {
          name: p?.name || t.userId,
          email: p?.email ?? "",
          active: fmtDurationMs(t.activeMs),
          activeHours: hoursOf(t.activeMs),
          idle: fmtDurationMs(t.idleMs),
          days: t.days,
          avg: fmtDurationMs(t.days ? t.activeMs / t.days : 0),
          sessions: t.sessions,
          events: t.events,
        };
      }),
  };
}

/** Every member, over a date range. */
export async function exportAllMembersActivityToXlsx(
  rows: ActivityExportRow[],
  directory: UserDTO[],
  filename: string,
): Promise<number> {
  const tz = localTimeZone();
  const people = directoryIndex(directory);
  return buildAndDownload(
    [
      summarySheet(rows, people),
      { name: "Daily", columns: dailyColumns(tz), rows: dailyRows(rows, people) },
    ],
    filename,
  );
}

/** One member, with their sign-in sessions alongside the daily totals. */
export async function exportMemberActivityToXlsx(
  rows: ActivityExportRow[],
  sessions: ActivitySessionDTO[],
  directory: UserDTO[],
  filename: string,
): Promise<number> {
  const tz = localTimeZone();
  const people = directoryIndex(directory);
  const sheets: SheetSpec[] = [
    { name: "Daily", columns: dailyColumns(tz), rows: dailyRows(rows, people) },
  ];
  if (sessions.length) {
    sheets.push({
      name: "Sessions",
      columns: [
        { header: "Device", key: "device", width: 26 },
        { header: `Started (${tz})`, key: "started", width: 24 },
        { header: `Ended (${tz})`, key: "ended", width: 24 },
        { header: "Ended because", key: "reason", width: 16 },
        { header: "Active", key: "active", width: 12 },
        { header: "Idle", key: "idle", width: 12 },
        { header: "Network", key: "ip", width: 18 },
      ],
      rows: sessions.map((s) => ({
        device: s.deviceLabel,
        started: fmtLocal(s.startedAt),
        ended: fmtLocal(s.endedAt),
        reason: s.endReason ?? (s.endedAt ? "" : "still active"),
        active: fmtDurationMs(s.activeMs),
        idle: fmtDurationMs(s.idleMs),
        // A /24, never the full address — the same coarsening the UI shows.
        ip: s.ipPrefix ?? "",
      })),
    });
  }
  return buildAndDownload(sheets, filename);
}
