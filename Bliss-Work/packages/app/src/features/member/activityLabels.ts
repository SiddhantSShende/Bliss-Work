/**
 * Turning stored activity into English.
 *
 * The store keeps stable machine verbs (`task.completed`, `route.dwell`) so the
 * aggregates can group on them for years. This is the only place they become
 * words, which means renaming a label never touches the data and never
 * invalidates a rollup.
 *
 * `t` is OPTIONAL on every export here, not required like the rest of the
 * i18n migration's helpers. This module is also imported directly by
 * apps/mobile (`@taskboard/app/features/member/activityLabels`), which has no
 * i18next instance at all — passing `t` is how the web client (MemberTimeline,
 * MemberAnalytics, MemberSessions) opts into translated labels, and omitting
 * it — as mobile's call sites do, unchanged — keeps returning the same plain
 * English strings this module always has, straight from the maps below.
 */
import { type ActivitySource, type TimelineEntry } from "@taskboard/shared";
import type { TFunction } from "i18next";

/** "They are back." — the web client's own tab regaining focus. */
const CAME_BACK = "Came back to BlissWork";

const ACTIONS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  "org.switched": "Switched workspace",
  "message.sent": "Sent a message",
  "mail.attachment.downloaded": "Downloaded a mail attachment",
  "attachment.opened": "Opened a file",
  "attachment.downloaded": "Downloaded a file",
  "channel.message.sent": "Posted in a channel",
  "conversation.ignored": "Ignored a conversation",
  "user.blocked": "Blocked someone",
  "user.unblocked": "Unblocked someone",
  "task.allocated": "Allocated a task",
  "task.acknowledged": "Acknowledged a task",
  "task.completed": "Completed a task",
  "task.ignored": "Ignored a task",
  "task.left": "Left a task",
  "task.reviewed": "Reviewed a task",
  "route.enter": "Opened",
  "route.dwell": "Spent time in",
  focus: CAME_BACK,
  blur: "Switched away from BlissWork",
  "idle.start": "Went idle",
  // The desktop's own readings (main-process tracker), as opposed to the web
  // client's in-window idle above: an application in front, and a stretch with
  // no keyboard or mouse input at the OS level. Both carry a duration.
  "app.focus": "Used",
  "os.idle": "Away from keyboard",
  "idle.end": "Became active",
  "screenshot.attempted": "Screenshot attempt blocked",
};

const SURFACES: Record<string, string> = {
  mail: "Mail",
  // What Mail was called before it was renamed. Kept because the timeline is
  // years of stored rows and the old ones still say "inbox".
  inbox: "Inbox",
  chats: "Chats",
  channels: "Channels",
  tasks: "Tasks",
  members: "Members",
  integrations: "Integrations",
  search: "Search",
  settings: "Settings",
  profile: "Profile",
  org: "Organization",
};

export function actionLabel(entry: TimelineEntry, t?: TFunction): string {
  const fallback = ACTIONS[entry.action] ?? entry.action;
  const verb = t
    ? t(`members:activityLabels.actions.${entry.action}`, { defaultValue: fallback, brand: "BlissWork" })
    : fallback;
  // Navigation and usage rows read as "Opened Tasks" — the verb alone would be
  // meaningless for them.
  if (entry.action === "app.focus") return entry.targetId ? `${verb} ${entry.targetId}` : verb;
  if (entry.action === "route.enter" || entry.action === "route.dwell") {
    const surface = surfaceLabel(entry.surface, t) ?? (t ? t("members:activityLabels.theApp") : "the app");
    return `${verb} ${surface}`;
  }
  return verb;
}

export function surfaceLabel(surface: string | null, t?: TFunction): string | null {
  if (!surface) return null;
  const fallback = SURFACES[surface] ?? surface;
  return t ? t(`members:activityLabels.surfaces.${surface}`, fallback) : fallback;
}

/** "2h 14m", "8m", "45s" — never "0s", which reads as broken rather than brief. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || ms < 1000) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/**
 * Whether a row is evidence or a claim.
 *
 * `server` rows are derived from events the services emitted while doing the
 * work — a client cannot forge, suppress or inflate them. Everything else is
 * self-reported. The distinction is surfaced in the UI and in the export
 * because it is load-bearing the moment anyone uses this screen to make a
 * decision about a person.
 */
export function sourceLabel(source: ActivitySource, t?: TFunction): { text: string; verified: boolean } {
  const tt = (key: string, fallback: string) => (t ? t(key, fallback) : fallback);
  switch (source) {
    case "server":
      return { text: tt("members:activityLabels.source.verified", "Verified"), verified: true };
    case "desktop":
      return { text: tt("members:activityLabels.source.desktop", "Desktop app"), verified: false };
    case "extension":
      return { text: tt("members:activityLabels.source.extension", "Browser extension"), verified: false };
    default:
      return { text: tt("members:activityLabels.source.web", "Web app"), verified: false };
  }
}

/** Day heading for the timeline: "Today", "Yesterday", then the date.
 *  `lang` is the in-app selected locale (`i18n.language`) for the date fall
 *  through — omitted (as mobile's call sites do), it behaves exactly as
 *  before and lets the platform pick a default. */
export function dayHeading(iso: string, t?: TFunction, lang?: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) {
    return t ? t("common:date.today", "Today") : "Today";
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return t ? t("common:date.yesterday", "Yesterday") : "Yesterday";
  }
  return d.toLocaleDateString(lang, {
    weekday: "long", day: "numeric", month: "long",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}
