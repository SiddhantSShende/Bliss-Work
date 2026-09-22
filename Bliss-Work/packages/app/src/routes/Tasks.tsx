import { useEffect, useMemo, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Plus, ListTodo, Download, PinOff } from "lucide-react";
import { Button, GlassCard, EmptyState, IconButton } from "@taskboard/ui";
import type { StickyTaskDTO, TaskAction, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { autoPinAssignedTask, unpinAssignedTask, useAssignedTaskPin } from "../lib/taskPinPrefs";
import { TERMINAL_VIEW_LIMIT, isTerminalView, terminalAt } from "./tasksBuckets";
import { AvailablePeople } from "../features/AvailablePeople";
import { CreateTaskDialog } from "../features/CreateTaskDialog";
import { ExportTasksDialog } from "../features/ExportTasksDialog";
import { MyTasksBoard } from "../features/MyTasksBoard";
import { StickyWidget } from "../features/StickyWidget";

const verb: Record<TaskAction, "acknowledge" | "complete" | "ignore" | "leave"> = {
  ACKNOWLEDGE: "acknowledge", COMPLETE: "complete", IGNORE: "ignore", LEAVE: "leave",
};
const TITLES: Record<string, string> = {
  mine: "My tasks", allocated: "Allocated to me", available: "Available",
  completed: "Completed", left: "Left", ignored: "Ignored",
};
// Bucket switcher shown only on phones (the TasksList side pane is hidden < md).
// Keep this order in lockstep with CATS in TasksList.
const BUCKETS = [
  { view: "allocated", label: "Allocated" },
  { view: "available", label: "Available" },
  { view: "mine", label: "My tasks" },
  { view: "completed", label: "Completed" },
  { view: "left", label: "Left" },
  { view: "ignored", label: "Ignored" },
] as const;

export function Tasks() {
  const { view = "allocated" } = useParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [preselect, setPreselect] = useState<UserDTO[]>([]);

  // CreateTaskDialog seeds its assignee set from `preselect` in an effect keyed
  // on `open` alone, so the preselect must be committed in the SAME render pass
  // that opens it — calling both setters synchronously here guarantees that
  // under React 18 automatic batching.
  const openCreate = (users: UserDTO[] = []) => {
    setPreselect(users);
    setCreateOpen(true);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-5">
        <h1 className="text-base font-semibold tracking-tight text-fg">{TITLES[view] ?? "Tasks"}</h1>
        <div className="flex items-center gap-2">
          {/* Export emits task rows — nothing to export from a people roster. */}
          {view !== "available" && (
            <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)} title="Export tasks to Excel">
              <Download size={15} /> Export
            </Button>
          )}
          <Button size="sm" onClick={() => openCreate()}><Plus size={15} /> New task</Button>
        </div>
      </header>
      <ExportTasksDialog open={exportOpen} onClose={() => setExportOpen(false)} />
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
        {view === "mine" ? <MyTasksBoard />
          : view === "available" ? <AvailablePeople onAssign={(u) => openCreate([u])} />
            : <AssignedBucket view={view} />}
      </div>
      <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} preselect={preselect} />
    </div>
  );
}

function AssignedBucket({ view }: { view: string }) {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const { data: all = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });
  const [page, setPage] = useState(1);
  const isDesktop = config.kind === "electron";
  const { isPinned } = useAssignedTaskPin();

  useEffect(() => {
    setPage(1);
  }, [view]);

  // Desktop-only, device-local "pinned" marker: the first time an assigned
  // task shows up here, mark it pinned so it carries an Unpin control. Purely
  // client-side (see lib/taskPinPrefs) — unrelated to the Electron desktop
  // popup (the always-on-top sticky note), which is main-process backed.
  useEffect(() => {
    if (!isDesktop) return;
    for (const t of all as StickyTaskDTO[]) {
      if (t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED") autoPinAssignedTask(t.taskId);
    }
  }, [all, isDesktop]);

  // Desktop-only: which tasks the user has pinned to the desktop. Source of
  // truth is the Electron main process; absent on web so the button hides.
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });

  // LEFT is its OWN terminal bucket — never folded into "Completed". Leaving a
  // task is a distinct outcome from completing it, and the user must see it
  // labelled "left" (to both parties), not "completed".
  const filteredTasks = useMemo(() => {
    const matched = all.filter((t: StickyTaskDTO) =>
      view === "ignored" ? t.myStatus === "IGNORED"
        : view === "left" ? t.myStatus === "LEFT"
          : view === "completed" ? t.myStatus === "COMPLETED"
            : t.myStatus === "SENT" || t.myStatus === "ACKNOWLEDGED",
    );
    if (!isTerminalView(view)) return matched;
    // Terminal buckets are history, and history only grows. Show the most
    // recent handful and stop.
    //
    // Sorted by when the task REACHED this bucket, not by when it was
    // assigned: a task handed over in January and completed today is the
    // newest thing in Completed, and ordering by assignedAt would bury it
    // under nine tasks nobody has touched since.
    return [...matched].sort((a, b) => terminalAt(b).localeCompare(terminalAt(a)));
  }, [all, view]);
  const pageCount = isTerminalView(view)
    ? Math.max(1, Math.ceil(filteredTasks.length / TERMINAL_VIEW_LIMIT))
    : 1;
  const currentPage = Math.min(page, pageCount);
  const tasks = isTerminalView(view)
    ? filteredTasks.slice((currentPage - 1) * TERMINAL_VIEW_LIMIT, currentPage * TERMINAL_VIEW_LIMIT)
    : filteredTasks;

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
      } else if (vars.action === "LEAVE") {
        toast.success("You left the task — the sender has been notified.");
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
      // My own transition moves me into/out of the Available roster — refresh it
      // here rather than waiting for the WS echo.
      void qc.invalidateQueries({ queryKey: qk.availability });
    },
  });

  if (tasks.length === 0)
    return <EmptyState icon={<ListTodo size={24} />} title="Nothing here" hint="Tasks appear here as they arrive." />;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence initial={false}>
          {tasks.map((t) => {
          // The lock tracks exactly what floats: pinned AND still acknowledged.
          // Keeps the in-app card in lockstep with the desktop note and avoids a
          // dead/locked card for a non-acknowledged status. Pinning itself is
          // automatic, so the card shows no pin control.
          const floatable = pinnedIds.includes(t.taskId) && t.myStatus === "ACKNOWLEDGED";
          const desktopPinned = isDesktop && isPinned(t.taskId);
          return (
            <motion.div
              key={t.taskId}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              className="relative"
            >
              {desktopPinned && (
                <IconButton
                  className="absolute right-2 top-2 z-10 bg-surface/90 shadow-soft"
                  title="Unpin"
                  aria-label="Unpin"
                  onClick={() => unpinAssignedTask(t.taskId)}
                >
                  <PinOff size={15} />
                </IconButton>
              )}
              <StickyWidget
                task={t}
                onAction={(a) => act.mutate({ taskId: t.taskId, action: a })}
                busy={act.isPending && act.variables?.taskId === t.taskId}
                locked={floatable}
              />
            </motion.div>
          );
          })}
        </AnimatePresence>
      </div>
      {isTerminalView(view) && pageCount > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3 text-xs text-muted">
          <Button variant="ghost" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
            Previous
          </Button>
          <span>Page {currentPage} of {pageCount}</span>
          <Button variant="ghost" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
            Next
          </Button>
        </div>
      )}
    </>
  );
}
