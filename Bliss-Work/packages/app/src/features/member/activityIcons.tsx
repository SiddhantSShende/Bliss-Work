/**
 * Icon for a timeline row, reused from the app's existing icon sets rather
 * than new assets: the nav rail's lucide-react icons for internal pages, and
 * appIcons.tsx's hand-drawn brand marks for external applications
 * (`app.focus` rows). Web-only — the timeline's row rendering lives in
 * MemberTimeline.tsx, not the shared activityLabels module mobile imports.
 */
import type { ComponentType } from "react";
import {
  Activity,
  Ban,
  Building2,
  Camera,
  Hash,
  ListTodo,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  Moon,
  Paperclip,
  Plug,
  Search,
  Settings,
  Sun,
  User,
  UserCheck,
  Users,
} from "lucide-react";
import type { TimelineEntry } from "@taskboard/shared";
import { getAppIcon } from "./appIcons";

type IconProps = { size?: number; className?: string };
type Icon = ComponentType<IconProps>;

/** Same action verbs as activityLabels.ts's ACTIONS map. */
const ACTION_ICONS: Record<string, Icon> = {
  login: LogIn,
  logout: LogOut,
  "org.switched": Building2,
  "message.sent": MessageSquare,
  "channel.message.sent": Hash,
  "mail.attachment.downloaded": Mail,
  "attachment.opened": Paperclip,
  "attachment.downloaded": Paperclip,
  "file.opened": Paperclip,
  "file.downloaded": Paperclip,
  "conversation.ignored": MessageSquare,
  "user.blocked": Ban,
  "user.unblocked": UserCheck,
  "task.allocated": ListTodo,
  "task.acknowledged": ListTodo,
  "task.completed": ListTodo,
  "task.ignored": ListTodo,
  "task.left": ListTodo,
  "task.reviewed": ListTodo,
  focus: Activity,
  blur: Activity,
  "idle.start": Moon,
  "idle.end": Sun,
  "os.idle": Moon,
  "screenshot.attempted": Camera,
};

/** Same surface keys as activityLabels.ts's SURFACES map — the rail's own
 *  icon for each internal page a route.enter/route.dwell row names. */
const SURFACE_ICONS: Record<string, Icon> = {
  mail: Mail,
  inbox: Mail,
  chats: MessageSquare,
  channels: Hash,
  tasks: ListTodo,
  members: Users,
  integrations: Plug,
  search: Search,
  settings: Settings,
  profile: User,
  org: Building2,
};

/** The icon for a timeline row: a brand mark for a known `app.focus`
 *  executable, else the surface's rail icon for a route row, else the
 *  action's icon, else a neutral fallback. Never a new asset. */
export function getActivityIcon(entry: Pick<TimelineEntry, "action" | "surface" | "targetId">): Icon {
  if (entry.action === "app.focus" && entry.targetId) {
    const brand = getAppIcon(entry.targetId);
    if (brand) return brand;
    return Activity;
  }
  if ((entry.action === "route.enter" || entry.action === "route.dwell") && entry.surface) {
    return SURFACE_ICONS[entry.surface] ?? Activity;
  }
  return ACTION_ICONS[entry.action] ?? Activity;
}
