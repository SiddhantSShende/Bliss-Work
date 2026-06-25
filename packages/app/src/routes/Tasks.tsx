import { useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Plus, ListTodo } from "lucide-react";
import { Badge, Button, GlassCard, EmptyState } from "@taskboard/ui";
import type { SentTaskDTO, StickyTaskDTO, TaskAction } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { CreateTaskDialog } from "../features/CreateTaskDialog";
import { StickyWidget } from "../features/StickyWidget";

const verb: Record<TaskAction, "acknowledge" | "complete" | "ignore" | "leave"> = {
  ACKNOWLEDGE: "acknowledge", COMPLETE: "complete", IGNORE: "ignore", LEAVE: "leave",
};
const TITLES: Record<string, string> = {
  mine: "My tasks", allocated: "Allocated to me", completed: "Completed", ignored: "Ignored",
};
// Bucket switcher shown only on phones (the TasksList side pane is hidden < md).
const BUCKETS = [
  { view: "allocated", label: "Allocated" },
  { view: "mine", label: "My tasks" },
  { view: "completed", label: "Completed" },
  { view: "ignored", label: "Ignored" },
] as const;

export function Tasks() {
  const { view = "allocated" } = useParams();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-5">
        <h1 className="text-base font-semibold tracking-tight text-fg">{TITLES[view] ?? "Tasks"}</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={15} /> New task</Button>
      </header>
      <div className="flex gap-2 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
        {BUCKETS.map((b) => (
          <NavLink
            key={b.view}
            to={`/app/tasks/${b.view}`}
            className={({ isActive }) =>
              `shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
              }`
            }
          >
            {b.label}
          </NavLink>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
        {view === "mine" ? <MyTasks /> : <AssignedBucket view={view} />}
      </div>
      <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function AssignedBucket({ view }: { view: string }) {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const { data: all = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });

  // Desktop-only: which tasks the user has pinned to the desktop. Source of
  // truth is the Electron main process; absent on web so the button hides.
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });

  const tasks = all.filter((t: StickyTaskDTO) =>
    view === "ignored" ? t.myStatus === "IGNORED"
      : view === "completed" ? t.myStatus === "COMPLETED" || t.myStatus === "LEFT"
        : t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED",
  );

  const act = useMutation({
    mutationFn: ({ taskId, action }: { taskId: string; action: TaskAction }) =>
      api.taskAction(taskId, verb[action]),
    // Optimistic update: the moment the user clicks Complete (or Ignore /
    // Leave) we remove the row from the actionable caches so the card +
    // sticky note disappear instantly, no waiting for the round-trip.
    // Acknowledge stays in place because the task remains actionable. If
    // the server rejects, onError rolls back from the snapshot.
    onMutate: async ({ taskId, action }) => {
      await qc.cancelQueries({ queryKey: qk.sticky });
      await qc.cancelQueries({ queryKey: qk.assigned });
      const snapshots = {
        sticky: qc.getQueryData<StickyTaskDTO[]>(qk.sticky),
        assigned: qc.getQueryData<StickyTaskDTO[]>(qk.assigned),
        inbox: qc.getQueryData<StickyTaskDTO[]>(qk.inbox),
      };
      const isTerminal = action === "COMPLETE" || action === "IGNORE" || action === "LEAVE";
      if (isTerminal) {
        // Drop the row from every cache that drives a still-actionable surface.
        const drop = (list: StickyTaskDTO[] | undefined) =>
          (list ?? []).filter((t) => t.taskId !== taskId);
        qc.setQueryData<StickyTaskDTO[]>(qk.sticky, drop);
        qc.setQueryData<StickyTaskDTO[]>(qk.inbox, drop);
        // Keep qk.assigned around but update the status so the Completed
        // bucket picks it up immediately.
        const statusFor: Record<TaskAction, StickyTaskDTO["myStatus"]> = {
          ACKNOWLEDGE: "ACKNOWLEDGED",
          COMPLETE: "COMPLETED",
          IGNORE: "IGNORED",
          LEAVE: "LEFT",
        };
        qc.setQueryData<StickyTaskDTO[]>(qk.assigned, (prev) =>
          (prev ?? []).map((t) =>
            t.taskId === taskId
              ? { ...t, myStatus: statusFor[action], actions: [] }
              : t,
          ),
        );
      } else {
        // Acknowledge: keep the row, flip the status so the card re-renders
        // with COMPLETE/LEAVE buttons and the sticky's Unpin replaces
        // Acknowledge/Ignore.
        const patchStatus = (list: StickyTaskDTO[] | undefined) =>
          (list ?? []).map((t) =>
            t.taskId === taskId
              ? { ...t, myStatus: "ACKNOWLEDGED" as const }
              : t,
          );
        qc.setQueryData<StickyTaskDTO[]>(qk.sticky, patchStatus);
        qc.setQueryData<StickyTaskDTO[]>(qk.assigned, patchStatus);
        qc.setQueryData<StickyTaskDTO[]>(qk.inbox, patchStatus);
      }
      return snapshots;
    },
    onError: (err, vars, snapshots) => {
      // Roll back optimistic edits — task is back where it was.
      if (snapshots?.sticky !== undefined) qc.setQueryData(qk.sticky, snapshots.sticky);
      if (snapshots?.assigned !== undefined) qc.setQueryData(qk.assigned, snapshots.assigned);
      if (snapshots?.inbox !== undefined) qc.setQueryData(qk.inbox, snapshots.inbox);
      toast.error(`Couldn't ${vars.action.toLowerCase()} the task`, {
        description: String(err),
      });
    },
    onSuccess: (_data, vars) => {
      if (vars.action === "COMPLETE") {
        toast.success("Task completed — the sender has been notified.");
      }
    },
    // Server reconciliation: refresh every mirror surface so the WS echo
    // can't briefly resurrect the row, and so any second device sees the
    // update without a manual refresh.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.assigned });
      void qc.invalidateQueries({ queryKey: qk.sticky });
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.sent });
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      void qc.invalidateQueries({ queryKey: qk.inboxPeers });
      void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
      void qc.invalidateQueries({ queryKey: qk.notifications });
    },
  });

  // Seed the pin cache from main's AUTHORITATIVE result (never an optimistic
  // guess): this reflects a refused pin (cap reached) and self-corrects if the
  // task didn't actually float.
  const pin = async (taskId: string) => {
    try {
      const res = await config.pinTask!(taskId);
      qc.setQueryData<string[]>(qk.taskPins, () => res.pinned);
      if (!res.ok && res.reason === "limit")
        toast("Desktop is full — complete or unpin a note first (max 5 pinned).");
    } catch {
      // IPC hiccup — reconcile against the real set on the next refetch.
      void qc.invalidateQueries({ queryKey: qk.taskPins });
    }
  };

  if (tasks.length === 0)
    return <EmptyState icon={<ListTodo size={24} />} title="Nothing here" hint="Tasks appear here as they arrive." />;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence initial={false}>
        {tasks.map((t) => {
          // Lock + "Pinned" chip track exactly what floats: pinned AND still
          // acknowledged. Keeps the in-app card in lockstep with the desktop
          // note and avoids a dead/locked card for a non-acknowledged status.
          const floatable = pinnedIds.includes(t.taskId) && t.myStatus === "ACKNOWLEDGED";
          return (
            <motion.div key={t.taskId} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}>
              <StickyWidget
                task={t}
                onAction={(a) => act.mutate({ taskId: t.taskId, action: a })}
                onPin={config.pinTask ? () => void pin(t.taskId) : undefined}
                pinned={floatable}
                locked={floatable}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function MyTasks() {
  const { api } = useRuntime();
  const { data: tasks = [] } = useQuery({ queryKey: qk.sent, queryFn: () => api.tasksSent() });
  if (tasks.length === 0)
    return <EmptyState icon={<ListTodo size={24} />} title="You haven't sent any tasks" hint="Create one with “New task”." />;

  const tone = (s: string) =>
    s === "COMPLETED" ? "success" : s === "ACKNOWLEDGED" ? "accent" : s === "IGNORED" || s === "LEFT" ? "danger" : "neutral";

  return (
    <div className="grid gap-3">
      {tasks.map((t: SentTaskDTO) => (
        <GlassCard key={t.taskId} className="p-4">
          <div className="font-semibold text-fg">{t.title}</div>
          {t.description && <p className="mt-1 text-sm text-muted">{t.description}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {t.assignees.map((a) => (
              <span key={a.assigneeId} className="inline-flex items-center gap-1.5 text-sm text-fg">
                {a.assigneeUsername}
                <Badge tone={tone(a.status) as "success" | "accent" | "danger" | "neutral"}>{a.status.toLowerCase()}</Badge>
              </span>
            ))}
          </div>
        </GlassCard>
      ))}
    </div>
  );
}
