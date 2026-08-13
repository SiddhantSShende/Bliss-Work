/**
 * Turning stored activity into English.
 *
 * The store keeps stable machine verbs (`task.completed`, `route.dwell`) so the
 * aggregates can group on them for years. This is the only place they become
 * words, which means renaming a label never touches the data and never
 * invalidates a rollup.
 */
import type { ActivitySource, TimelineEntry } from "@taskboard/shared";

const ACTIONS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  "org.switched": "Switched workspace",
  "message.sent": "Sent a message",
  "channel.message.sent": "Posted in a channel",
  "message.forwarded": "Forwarded a message",
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
  "app.focus": "Used",
  "site.visit": "Visited",
  focus: "Came back to BlissWork",
  blur: "Switched away from BlissWork",
  "idle.start": "Went idle",
  "idle.end": "Became active",
  heartbeat: "Active",
};

const SURFACES: Record<string, string> = {
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

export function actionLabel(entry: TimelineEntry): string {
  const verb = ACTIONS[entry.action] ?? entry.action;
  // Navigation and usage rows read as "Opened Tasks" / "Used Google Chrome" —
  // the verb alone would be meaningless for them.
  if (entry.action === "route.enter" || entry.action === "route.dwell") {
    return `${verb} ${surfaceLabel(entry.surface) ?? "the app"}`;
  }
  if (entry.action === "app.focus" || entry.action === "site.visit") {
    return `${verb} ${entry.targetId ?? "something"}`;
  }
  return verb;
}

export function surfaceLabel(surface: string | null): string | null {
  if (!surface) return null;
  return SURFACES[surface] ?? surface;
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
export function sourceLabel(source: ActivitySource): { text: string; verified: boolean } {
  switch (source) {
    case "server":
      return { text: "Verified", verified: true };
    case "desktop":
      return { text: "Desktop app", verified: false };
    case "extension":
      return { text: "Browser extension", verified: false };
    default:
      return { text: "Web app", verified: false };
  }
}

/** Day heading for the timeline: "Today", "Yesterday", then the date. */
export function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}
