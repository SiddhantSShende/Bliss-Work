import { useMemo, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Plus, ListTodo, Download, Star, MessageSquarePlus } from "lucide-react";
import { Badge, Button, GlassCard, EmptyState } from "@taskboard/ui";
import type { SentTaskDTO, StickyTaskDTO, TaskAction, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { TERMINAL_VIEW_LIMIT, isTerminalView, terminalAt } from "./tasksBuckets";
import { AvailablePeople } from "../features/AvailablePeople";
import { CreateTaskDialog } from "../features/CreateTaskDialog";
import { ExportTasksDialog } from "../features/ExportTasksDialog";
import { CreateReviewDialog } from "../features/CreateReviewDialog";
import { StickyWidget } from "../features/StickyWidget";

type SentAssignee = SentTaskDTO["assignees"][number];

/** Format an ISO instant to the viewer's local date + time (or "" when absent). */
function fmtTs(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
        {view === "mine" ? <MyTasks />
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
  const tasks = useMemo(() => {
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
    return [...matched]
      .sort((a, b) => terminalAt(b).localeCompare(terminalAt(a)))
      .slice(0, TERMINAL_VIEW_LIMIT);
  }, [all, view]);

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

type BadgeTone = "success" | "accent" | "danger" | "neutral";
const statusTone = (s: string): BadgeTone =>
  s === "COMPLETED" ? "success" : s === "ACKNOWLEDGED" ? "accent" : s === "IGNORED" || s === "LEFT" ? "danger" : "neutral";

function MyTasks() {
  const { api } = useRuntime();
  const { data: tasks = [] } = useQuery({ queryKey: qk.sent, queryFn: () => api.tasksSent() });
  const [reviewTarget, setReviewTarget] = useState<{ taskId: string; assignee: SentAssignee } | null>(null);

  if (tasks.length === 0)
    return <EmptyState icon={<ListTodo size={24} />} title="You haven't sent any tasks" hint="Create one with “New task”." />;

  return (
    <>
      <div className="grid gap-3">
        {tasks.map((t: SentTaskDTO) => (
          <GlassCard key={t.taskId} className="p-4">
            <div className="font-semibold text-fg">{t.title}</div>
            {t.description && <p className="mt-1 text-sm text-muted">{t.description}</p>}
            <div className="mt-3 flex flex-col divide-y divide-border/50">
              {t.assignees.map((a) => (
                <AssigneeTimeline
                  key={a.assigneeId}
                  assignee={a}
                  onReview={() => setReviewTarget({ taskId: t.taskId, assignee: a })}
                />
              ))}
            </div>
          </GlassCard>
        ))}
      </div>
      {reviewTarget && (
        <CreateReviewDialog
          open={!!reviewTarget}
          onClose={() => setReviewTarget(null)}
          taskId={reviewTarget.taskId}
          assigneeId={reviewTarget.assignee.assigneeId}
          assigneeName={reviewTarget.assignee.assigneeUsername}
          existingText={reviewTarget.assignee.review}
          existingRating={reviewTarget.assignee.reviewRating}
        />
      )}
    </>
  );
}

/** One assignee's status + full timeline + the review the allocator left. */
function AssigneeTimeline({ assignee: a, onReview }: { assignee: SentAssignee; onReview: () => void }) {
  const milestones = [
    { label: "Allocated", at: a.assignedAt },
    { label: "Acknowledged", at: a.acknowledgedAt },
    { label: "Ignored", at: a.ignoredAt },
    { label: "Completed", at: a.completedAt },
    { label: "Left", at: a.leftAt },
    { label: "Reviewed", at: a.reviewedAt },
  ].filter((m) => m.at);

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-fg">
          {a.assigneeUsername}
          <Badge tone={statusTone(a.status)}>{a.status.toLowerCase()}</Badge>
        </span>
        {a.status === "COMPLETED" && (
          <Button variant="ghost" size="sm" onClick={onReview}>
            <MessageSquarePlus size={14} /> {a.review ? "Edit review" : "Write review"}
          </Button>
        )}
      </div>
      {milestones.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {milestones.map((m) => (
            <span key={m.label}>
              <span className="text-fg/70">{m.label}</span> {fmtTs(m.at)}
            </span>
          ))}
        </div>
      )}
      {a.review && (
        <div className="mt-2 rounded-lg bg-surface-2/60 p-2.5 text-sm">
          {a.reviewRating != null && (
            <div className="mb-1 flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  size={14}
                  className={n <= a.reviewRating! ? "fill-amber-400 text-amber-400" : "text-muted/40"}
                />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap text-muted">{a.review}</p>
        </div>
      )}
    </div>
  );
}
