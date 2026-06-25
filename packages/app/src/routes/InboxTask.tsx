import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { StickyTaskDTO, TaskAction } from "@taskboard/shared";
import { EmptyState } from "@taskboard/ui";
import { ListTodo } from "lucide-react";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { StickyWidget } from "../features/StickyWidget";

/**
 * Main pane content for /app/inbox/task/:taskId.
 *
 * Looks the task up in the existing tasks/inbox query data first (cheap),
 * falls back to the sticky list as a secondary cache, then to a fresh
 * refetch of /api/v1/tasks/inbox. Uses the existing StickyWidget component
 * in non-compact mode for the actual rendering — Design Decision #3 keeps
 * task UX consistent across inbox / sticky.
 */
export function InboxTask() {
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
  const task: StickyTaskDTO | undefined =
    inboxTasks.find((t) => t.taskId === taskId) ??
    qc.getQueryData<StickyTaskDTO[]>(qk.sticky)?.find((t) => t.taskId === taskId);

  const actMut = useMutation({
    mutationFn: (action: TaskAction) =>
      api.taskAction(taskId!, action.toLowerCase() as "acknowledge" | "complete" | "ignore" | "leave"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: qk.sticky });
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    },
  });

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<ListTodo size={26} />}
          title="Task not found"
          hint="It may have been completed, ignored, or removed."
        />
      </div>
    );
  }

  // Lock + chip track what actually floats: pinned AND still acknowledged.
  const floatable = pinnedIds.includes(task.taskId) && task.myStatus === "ACKNOWLEDGED";
  const pin = async () => {
    try {
      const res = await config.pinTask!(task.taskId);
      qc.setQueryData<string[]>(qk.taskPins, () => res.pinned);
      if (!res.ok && res.reason === "limit")
        toast("Desktop is full — complete or unpin a note first (max 5 pinned).");
    } catch {
      void qc.invalidateQueries({ queryKey: qk.taskPins });
    }
  };

  return (
    <div className="flex h-full items-start justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl">
        <StickyWidget
          task={task}
          onAction={(a) => actMut.mutate(a)}
          compact={false}
          onPin={config.pinTask ? () => void pin() : undefined}
          pinned={floatable}
          locked={floatable}
        />
      </div>
    </div>
  );
}
