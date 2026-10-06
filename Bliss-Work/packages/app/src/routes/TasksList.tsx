import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Send, Inbox, CheckCircle2, Ban, LogOut, UserCheck, AlarmClockOff } from "lucide-react";
import type { StickyTaskDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useAvailability } from "../lib/useAvailability";
import { useDeadlineRefetch } from "../lib/useDeadlineRefetch";
import { useMarkTaskNotificationsRead } from "../lib/useMarkTaskNotificationsRead";
import { ListHeader, NavIconTile, rowClass } from "../features/ListPane";

const CATS = [
  { view: "mine", icon: Send },
  { view: "allocated", icon: Inbox },
  { view: "available", icon: UserCheck },
  { view: "completed", icon: CheckCircle2 },
  { view: "left", icon: LogOut },
  { view: "ignored", icon: Ban },
  { view: "missed", icon: AlarmClockOff },
] as const;

export function TasksList() {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const { data: assigned = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });
  const { data: sent = [] } = useQuery({ queryKey: qk.sent, queryFn: () => api.tasksSent() });
  // Same hook the pane uses, so the badge and the grid can never disagree —
  // TanStack dedupes the underlying queries, so this costs no extra network.
  const { roster } = useAvailability();

  // This panel mounts the instant the Tasks section opens — unlike Tasks.tsx's
  // sub-views, which only ever hold ONE of these two lists at a time (whichever
  // bucket happens to be active), and default to "Allocated to me", not "My
  // tasks". TASK_ACKNOWLEDGED/COMPLETED/IGNORED/LEFT notifications go to the
  // allocator (see notification-svc's consumer), so `sent` clears those, and
  // TASK_ASSIGNED goes to the assignee, so `assigned` clears that one. One call
  // for both lists: a self-assigned task is in each.
  useMarkTaskNotificationsRead(api, [...sent, ...assigned]);
  // A deadline passing moves a card to Missed even if the realtime push is lost.
  useDeadlineRefetch(assigned);

  const active = (t: StickyTaskDTO) => t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED";
  const counts: Record<string, number> = {
    mine: sent.length,
    allocated: assigned.filter(active).length,
    available: roster.length,
    completed: assigned.filter((t) => t.myStatus === "COMPLETED").length,
    left: assigned.filter((t) => t.myStatus === "LEFT").length,
    ignored: assigned.filter((t) => t.myStatus === "IGNORED").length,
    missed: assigned.filter((t) => t.myStatus === "MISSED").length,
  };

  const categoryLabel: Record<(typeof CATS)[number]["view"], string> = {
    mine: t("tasksList.categories.mine"),
    allocated: t("tasksList.categories.allocated"),
    available: t("tasksList.categories.available"),
    completed: t("tasksList.categories.completed"),
    left: t("tasksList.categories.left"),
    ignored: t("tasksList.categories.ignored"),
    missed: t("tasksList.categories.missed"),
  };

  return (
    <>
      <ListHeader title={t("tasksList.header")} />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {CATS.map((c) => {
          const n = counts[c.view] ?? 0;
          return (
            <NavLink key={c.view} to={`/app/tasks/${c.view}`} className={({ isActive }) => rowClass(isActive)}>
              <NavIconTile>
                <c.icon size={17} />
              </NavIconTile>
              <span className="flex-1 text-sm font-medium text-fg">{categoryLabel[c.view]}</span>
              {n > 0 && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted">{n}</span>
              )}
            </NavLink>
          );
        })}
      </div>
    </>
  );
}
