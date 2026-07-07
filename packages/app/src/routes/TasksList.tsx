import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Send, Inbox, CheckCircle2, Ban, LogOut } from "lucide-react";
import type { StickyTaskDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass } from "../features/ListPane";

const CATS = [
  { view: "mine", label: "My tasks", icon: Send },
  { view: "allocated", label: "Allocated to me", icon: Inbox },
  { view: "completed", label: "Completed", icon: CheckCircle2 },
  { view: "left", label: "Left", icon: LogOut },
  { view: "ignored", label: "Ignored", icon: Ban },
] as const;

export function TasksList() {
  const { api } = useRuntime();
  const { data: assigned = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });
  const { data: sent = [] } = useQuery({ queryKey: qk.sent, queryFn: () => api.tasksSent() });

  const active = (t: StickyTaskDTO) => t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED";
  const counts: Record<string, number> = {
    mine: sent.length,
    allocated: assigned.filter(active).length,
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
              <span className="flex-1 font-medium text-fg">{c.label}</span>
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
