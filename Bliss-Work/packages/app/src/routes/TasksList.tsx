import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Send, Inbox, CheckCircle2, Ban, LogOut, UserCheck } from "lucide-react";
import type { StickyTaskDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useAvailability } from "../lib/useAvailability";
import { useMarkTaskNotificationsRead } from "../lib/useMarkTaskNotificationsRead";
import { ListHeader, rowClass } from "../features/ListPane";

const CATS = [
  { view: "mine", label: "My tasks", icon: Send },
  { view: "allocated", label: "Allocated to me", icon: Inbox },
  { view: "available", label: "Available", icon: UserCheck },
  { view: "completed", label: "Completed", icon: CheckCircle2 },
  { view: "left", label: "Left", icon: LogOut },
  { view: "ignored", label: "Ignored", icon: Ban },
] as const;

export function TasksList() {
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
  // allocator (see notification-svc's consumer), so `sent` is what actually
  // clears the bell here; `assigned` is a no-op today but future-proofs an
  // assignee-directed kind.
  useMarkTaskNotificationsRead(api, sent);
  useMarkTaskNotificationsRead(api, assigned);

  const active = (t: StickyTaskDTO) => t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED";
  const counts: Record<string, number> = {
    mine: sent.length,
    allocated: assigned.filter(active).length,
    available: roster.length,
    completed: assigned.filter((t) => t.myStatus === "COMPLETED").length,
    left: assigned.filter((t) => t.myStatus === "LEFT").length,
    ignored: assigned.filter((t) => t.myStatus === "IGNORED").length,
  };

  return (
    <>
      <ListHeader title="Tasks" />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {CATS.map((c) => {
          const n = counts[c.view] ?? 0;
          return (
            <NavLink key={c.view} to={`/app/tasks/${c.view}`} className={({ isActive }) => rowClass(isActive)}>
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <c.icon size={17} />
              </span>
              <span className="flex-1 text-sm font-medium text-fg">{c.label}</span>
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
