import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Plus, ListTodo, Download } from "lucide-react";
import { Button, GlassCard, EmptyState } from "@taskboard/ui";
import { actionsFor, canPinTask, type StickyTaskDTO, type TaskAction, type UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { TERMINAL_VIEW_LIMIT, isTerminalView, terminalAt } from "./tasksBuckets";
import type { ParticipantTargets } from "../features/AddParticipantsPicker";
import { AvailablePeople } from "../features/AvailablePeople";
import { CreateTaskDialog } from "../features/CreateTaskDialog";
import { ExportTasksDialog } from "../features/ExportTasksDialog";
import { MyTasksBoard } from "../features/MyTasksBoard";
import { useMySentTasks } from "../features/useMySentTasks";
import { StickyWidget } from "../features/StickyWidget";
import { TASK_CARD_GRID } from "../features/taskCardLayout";
import { TaskPinToggle } from "../features/TaskPinToggle";
import { useOpenTaskDiscussion } from "../lib/useOpenTaskDiscussion";
import { useProjects } from "../features/useProjects";

const verb: Record<TaskAction, "acknowledge" | "complete" | "ignore" | "leave"> = {
  ACKNOWLEDGE: "acknowledge", COMPLETE: "complete", IGNORE: "ignore", LEAVE: "leave",
};
// Bucket switcher shown only on phones (the TasksList side pane is hidden < md).
// Keep this order in lockstep with CATS in TasksList.
const BUCKET_VIEWS = ["allocated", "available", "mine", "completed", "left", "ignored", "missed"] as const;

export function Tasks() {
  const { t } = useTranslation("tasks");
  const { view = "allocated" } = useParams();
  const projects = useProjects();
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

  const titleByView: Record<string, string> = {
    mine: t("tasksPage.titles.mine"),
    allocated: t("tasksPage.titles.allocated"),
    available: t("tasksPage.titles.available"),
    completed: t("tasksPage.titles.completed"),
    left: t("tasksPage.titles.left"),
    ignored: t("tasksPage.titles.ignored"),
    missed: t("tasksPage.titles.missed"),
  };
  const bucketLabel: Record<(typeof BUCKET_VIEWS)[number], string> = {
    allocated: t("tasksPage.buckets.allocated"),
    available: t("tasksPage.buckets.available"),
    mine: t("tasksPage.buckets.mine"),
    completed: t("tasksPage.buckets.completed"),
    left: t("tasksPage.buckets.left"),
    ignored: t("tasksPage.buckets.ignored"),
    missed: t("tasksPage.buckets.missed"),
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight text-fg">{titleByView[view] ?? t("tasksPage.titles.default")}</h1>
          {view === "mine" && <MyTasksCount />}
        </div>
        <div className="flex items-center gap-2">
          {/* Export emits task rows — nothing to export from a people roster. */}
          {view !== "available" && (
            <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)} title={t("tasksPage.export.title")}>
              <Download size={15} /> {t("tasksPage.export.button")}
            </Button>
          )}
          <Button size="sm" onClick={() => openCreate()}><Plus size={15} /> {t("tasksPage.newTask")}</Button>
        </div>
      </header>
      <ExportTasksDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {projects.data && projects.data.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
          {projects.data.map((project) => (
            <NavLink
              key={project.id}
              to={`/app/tasks/projects/${project.id}`}
              className={({ isActive }) =>
                `max-w-52 shrink-0 truncate rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
                }`
              }
            >
              {project.name}
            </NavLink>
          ))}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto border-b border-border/60 px-3 py-2 md:hidden">
        {BUCKET_VIEWS.map((bucketView) => (
          <NavLink
            key={bucketView}
            to={`/app/tasks/${bucketView}`}
            className={({ isActive }) =>
              `shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
              }`
            }

          >
            {bucketLabel[bucketView]}
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

/** How many sent tasks are loaded; "N+" while older pages remain on the server. */
function MyTasksCount() {
  const { t } = useTranslation("tasks");
  const { sent, tasks } = useMySentTasks();
  if (!sent.data) return null;
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
      {sent.hasNextPage ? t("tasksPage.countMore", { count: tasks.length }) : t("tasksPage.count", { count: tasks.length })}
    </span>
  );
}

export function ProjectAssignedTasks({ projectId = "" }: { projectId?: string }) {
  return <AssignedBucket view="project" projectId={projectId} />;
}

function AssignedBucket({ view, projectId }: { view: string; projectId?: string }) {
  const { t } = useTranslation("tasks");
  const { api, config } = useRuntime();
  const currentUserId = useSession((s) => s.user?.id);
  const qc = useQueryClient();
  const { data: all = [] } = useQuery({ queryKey: qk.assigned, queryFn: () => api.taskAssigned() });
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [view, projectId]);

  // Desktop-only: which tasks the user has pinned to the desktop. Source of
  // truth is the Electron main process; absent on web so the button hides.
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });

  // MISSED likewise: a task whose deadline passed unmet is neither completed nor
  // something the user chose to drop, and it leaves Allocated to me for good.
  // LEFT is its OWN terminal bucket — never folded into "Completed". Leaving a
  // task is a distinct outcome from completing it, and the user must see it
  // labelled "left" (to both parties), not "completed".
  const filteredTasks = useMemo(() => {
    const matched = all.filter((t: StickyTaskDTO) =>
      projectId ? t.projectId === projectId
        : view === "ignored" ? t.myStatus === "IGNORED"
        : view === "left" ? t.myStatus === "LEFT"
          : view === "missed" ? t.myStatus === "MISSED"
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
  }, [all, view, projectId]);
  const pageCount = isTerminalView(view)
    ? Math.max(1, Math.ceil(filteredTasks.length / TERMINAL_VIEW_LIMIT))
    : 1;
  const currentPage = Math.min(page, pageCount);
  const tasks = isTerminalView(view)
    ? filteredTasks.slice((currentPage - 1) * TERMINAL_VIEW_LIMIT, currentPage * TERMINAL_VIEW_LIMIT)
    : filteredTasks;

  // Every assigned task's chat target + unread count, in one call — see
  // useOpenTaskDiscussion. Sourced from `all` (not the view-filtered/paginated
  // `tasks` below) so this stays ONE stable query across every bucket view —
  // qk.taskDiscussions is a root key, and a per-view task-id set here would
  // make different buckets fight over the same cache entry.
  const allTaskIds = useMemo(() => all.map((t: StickyTaskDTO) => t.taskId), [all]);
  const { data: discussions = [] } = useQuery({
    queryKey: qk.taskDiscussions,
    queryFn: () => api.taskDiscussions(allTaskIds),
    enabled: allTaskIds.length > 0,
  });
  const unreadByTask = useMemo(
    () => new Map(discussions.map((d) => [d.taskId, d.unreadCount])),
    [discussions],
  );
  const { openDiscussion, busy: chatBusy } = useOpenTaskDiscussion();

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
              ? { ...t, myStatus: "ACKNOWLEDGED" as const, actions: actionsFor("ACKNOWLEDGED") }
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
      const actionVerbLabel: Record<TaskAction, string> = {
        ACKNOWLEDGE: t("tasksPage.actionVerbs.acknowledge"),
        COMPLETE: t("tasksPage.actionVerbs.complete"),
        IGNORE: t("tasksPage.actionVerbs.ignore"),
        LEAVE: t("tasksPage.actionVerbs.leave"),
      };
      toast.error(t("tasksPage.toasts.actionFailed", { verb: actionVerbLabel[vars.action] }), {
        description: String(err),
      });
    },
    onSuccess: (_data, vars) => {
      if (vars.action === "COMPLETE") {
        toast.success(t("tasksPage.toasts.completed"));
      } else if (vars.action === "LEAVE") {
        toast.success(t("tasksPage.toasts.left"));
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
  // Withdraw from your own assignment is the Ignore / Leave mutation above, not a
  // new one — same request, same optimistic update, same reconciliation. What it
  // adds is a latch: `act.isPending` reaches a click a render late, so two quick
  // clicks would each send a request. Held per task until that request settles.
  const withdrawing = useRef(new Set<string>());
  const withdrawSelf = (taskId: string, action: Extract<TaskAction, "IGNORE" | "LEAVE">) => {
    if (withdrawing.current.has(taskId)) return;
    withdrawing.current.add(taskId);
    act.mutate({ taskId, action }, { onSettled: () => withdrawing.current.delete(taskId) });
  };
  const membership = useMutation({
    mutationFn: ({ taskId, targets }: { taskId: string; targets: ParticipantTargets }) => api.addTaskParticipants(taskId, targets),
    onSuccess: (result) => {
      toast.success(t("participants.added"));
      if (result.projectChannelSyncFailed) toast.error(t("projects.syncFailed"));
      for (const key of [qk.assigned, qk.sticky, qk.inbox, qk.sent]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });
  const withdrawal = useMutation({
    mutationFn: ({ taskId, userId }: { taskId: string; userId: string }) => api.withdrawTaskParticipant(taskId, userId),
    onSuccess: () => {
      toast.success(t("participants.withdrawn"));
      for (const key of [qk.assigned, qk.sticky, qk.inbox, qk.sent]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });

  if (tasks.length === 0)
    return (
      <EmptyState
        icon={<ListTodo size={24} />}
        title={projectId ? t("projects.noTasks") : t("tasksPage.empty.title")}
        hint={projectId ? undefined : view === "missed" ? t("tasksPage.empty.missedHint") : t("tasksPage.empty.hint")}
      />
    );

  return (
    <>
      <div className={TASK_CARD_GRID}>
        <AnimatePresence initial={false}>
          {tasks.map((task) => {
          // The lock tracks exactly what floats: pinned AND still acknowledged.
          // Keeps the in-app card in lockstep with the desktop note and avoids a
          // dead/locked card for a non-acknowledged status.
          const floatable = pinnedIds.includes(task.taskId) && task.myStatus === "ACKNOWLEDGED";
          return (
            <motion.div
              key={task.taskId}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              // min-w-0: a grid item's automatic minimum width is its content's
              // min-content, so without it a card whose content cannot shrink is not
              // narrowed to its column — it sticks out of it.
              className="relative min-w-0"
            >
              <StickyWidget
                task={task}
                onAction={(a) => act.mutate({ taskId: task.taskId, action: a })}
                busy={(act.isPending && act.variables?.taskId === task.taskId) || membership.isPending || withdrawal.isPending}
                locked={floatable}
                currentUserId={currentUserId}
                participantLayout="list"
                landscape
                // Allocated to me is the viewer's own work: no participants block there.
                hideParticipants={view === "allocated"}
                onWithdrawSelf={(action) => withdrawSelf(task.taskId, action)}
                // The top-right corner is the user's shared Pin / Unpin — only for
                // a task that can still float. Ignore and Leave stay in the
                // button row.
                headerPin={canPinTask(task.myStatus) ? <TaskPinToggle taskId={task.taskId} /> : undefined}
                onAddParticipants={(targets) => membership.mutateAsync({ taskId: task.taskId, targets }).then(() => undefined)}
                onWithdrawParticipant={(userId) => withdrawal.mutateAsync({ taskId: task.taskId, userId }).then(() => undefined)}
                onChat={() =>
                  openDiscussion(
                    task.channelId
                      ? { taskId: task.taskId, channelId: task.channelId }
                      : { taskId: task.taskId, peerId: task.senderId },
                  )
                }
                chatBusy={chatBusy}
                chatUnreadCount={unreadByTask.get(task.taskId)}
              />
            </motion.div>
          );
          })}
        </AnimatePresence>
      </div>
      {isTerminalView(view) && pageCount > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3 text-xs text-muted">
          <Button variant="ghost" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
            {t("tasksPage.pagination.previous")}
          </Button>
          <span>{t("tasksPage.pagination.pageOf", { current: currentPage, total: pageCount })}</span>
          <Button variant="ghost" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>
            {t("tasksPage.pagination.next")}
          </Button>
        </div>
      )}
    </>
  );
}
