import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ApiError, type NotificationDTO, type StickyTaskDTO, type TaskAction } from "@taskboard/shared";
import { EmptyState } from "@taskboard/ui";
import { ListTodo } from "lucide-react";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { decrementUnreadCount, refreshUnreadCount } from "../lib/unreadNotificationCount";
import { StickyWidget } from "../features/StickyWidget";

/**
 * Main pane content for /app/mail/task/:taskId.
 *
 * Looks the task up in the existing tasks/inbox query data first (cheap),
 * falls back to the sticky list as a secondary cache, and finally to a
 * server fetch of /api/v1/tasks/:id/detail. The active-only list endpoints
 * never carry terminal tasks (completed/ignored/left), so without the
 * server fallback a terminal task opened from the unified inbox would wrongly
 * render "Task not found". Uses the existing StickyWidget component in
 * non-compact mode for the actual rendering — keeps task UX consistent across
 * inbox / sticky.
 */
export function MailTask() {
  const { t } = useTranslation("mail");
  const { taskId } = useParams<{ taskId: string }>();
  const { api, config } = useRuntime();
  const qc = useQueryClient();

  // We piggyback on the existing task-inbox query that the rest of the app
  // already keeps fresh — no new endpoint, no new fetch.
  const { data: inboxTasks = [] } = useQuery({
    queryKey: qk.inbox,
    queryFn: () => api.taskInbox(),
  });
  // Desktop-only pin set (empty/absent on web → the Pin button hides itself).
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });
  const cached: StickyTaskDTO | undefined =
    inboxTasks.find((t) => t.taskId === taskId) ??
    qc.getQueryData<StickyTaskDTO[]>(qk.sticky)?.find((t) => t.taskId === taskId);

  // Server fallback for terminal tasks (completed/ignored/left) that aren't in
  // the active-only list caches. Only runs on a cache miss.
  const { data: fetched, isLoading: fetching } = useQuery({
    queryKey: ["taskDetail", taskId],
    queryFn: () => api.taskDetail(taskId!),
    enabled: !!taskId && !cached,
    retry: false,
  });
  const task: StickyTaskDTO | undefined = cached ?? fetched;

  const actMut = useMutation({
    mutationFn: (action: TaskAction) =>
      api.taskAction(taskId!, action.toLowerCase() as "acknowledge" | "complete" | "ignore" | "leave"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.sticky });
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : t("task.couldNotUpdateToast")),
  });

  // Mark the task "seen" the moment its detail view opens. Task inbox rows are
  // seeded unread_count=1 with no other clearing path, so this is what finally
  // drops the unified-inbox badge, the People-sidebar pill, and the left-rail
  // count. Fires once per taskId; the sidebar/feed refetch reconciles the badges.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || markedRef.current === taskId) return;
    markedRef.current = taskId;
    // Deliberately does NOT touch the task's floating note. Reading a task is
    // not the same as dealing with it: the note is a commitment marker, and it
    // stays until the task is Completed, Ignored or Left. This effect once
    // cleared the note too — and because that clearing was PERSISTED, merely
    // clicking the task's row in the inbox retired its note for good while the
    // task was still outstanding. That is the bug this comment guards against;
    // clearing the unread BADGE below is the part that was always right.
    void api
      .readInboxItem("TASK", taskId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.inboxPeers });
        void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      })
      .catch(() => {
        markedRef.current = null; // allow a retry on the next open
      });

    // readInboxItem (above) only clears the unified-inbox badge. The bell's
    // OWN unread state (notification-svc, surfaced in NotificationsPanel) is a
    // separate system that nothing but the bell itself ever wrote to — so a
    // "Task completed by …" notification stayed lit even after its task was
    // opened and reviewed here. Opening IS reading it, for the bell — but only
    // for the bell. The floating note is a commitment, not a notification, and
    // is deliberately left alone (see above).
    const unreadForTask = (qc.getQueryData<NotificationDTO[]>(qk.notifications) ?? []).filter(
      (n) => n.taskId === taskId && !n.read,
    );
    if (unreadForTask.length > 0) {
      qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
        (prev ?? []).map((n) => (n.taskId === taskId ? { ...n, read: true } : n)),
      );
      decrementUnreadCount(qc, unreadForTask.length);
      void Promise.all(unreadForTask.map((n) => api.markNotificationRead(n.id).catch(() => {}))).then(() =>
        refreshUnreadCount(qc),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  if (!task) {
    // Still resolving the server fallback — don't flash "not found".
    if (fetching) {
      return (
        <div className="flex h-full items-center justify-center text-muted">{t("shared.loading")}</div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<ListTodo size={26} />}
          title={t("task.notFoundTitle")}
          hint={t("task.notFoundHint")}
        />
      </div>
    );
  }

  // The lock tracks what actually floats: pinned AND still acknowledged.
  // Pinning itself is automatic, so the card shows no pin control.
  const floatable = pinnedIds.includes(task.taskId) && task.myStatus === "ACKNOWLEDGED";

  return (
    <div className="flex h-full items-start justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl">
        <StickyWidget
          task={task}
          onAction={(a) => actMut.mutate(a)}
          busy={actMut.isPending}
          compact={false}
          locked={floatable}
        />
      </div>
    </div>
  );
}
