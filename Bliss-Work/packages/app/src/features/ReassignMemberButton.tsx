import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { ApiError } from "@taskboard/shared";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/**
 * "Re-add" on one Completed/Left/Ignored participant row of a sent task that
 * is still active overall — someone (say Divya) ignored or left their part
 * while other assignees keep working it, so the task-wide `ReassignTaskButton`
 * (which needs the whole task finished) isn't available yet. This hands that
 * one person's assignment back without touching anyone else's status or the
 * task lifecycle (task-svc `POST /tasks/{id}/assignees/{userId}/reassign`).
 */
export function ReassignMemberButton({
  taskId,
  userId,
  name,
  className,
}: {
  taskId: string;
  userId: string;
  name: string;
  className?: string;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  // Same TanStack `isPending` lag as the task-wide button: a latch, not `disabled`
  // alone, stops a fast double click from firing the request twice.
  const inFlight = useRef(false);
  const reassign = useMutation({
    mutationFn: () => api.reassignTaskMember(taskId, userId),
    onSuccess: ({ projectChannelSyncFailed }) => {
      toast.success(t("myTasksBoard.reassignMember.done", { name }));
      if (projectChannelSyncFailed) toast.error(t("projects.syncFailed"));
    },
    onError: (err) =>
      toast.error(t("myTasksBoard.reassignMember.failed"), {
        description: err instanceof ApiError ? err.message : String(err),
      }),
    onSettled: () => {
      inFlight.current = false;
      void qc.invalidateQueries({ queryKey: qk.sent });
      void qc.invalidateQueries({ queryKey: qk.assigned });
    },
  });
  return (
    <Button
      variant="secondary"
      size="sm"
      className={className}
      disabled={reassign.isPending}
      onClick={() => {
        if (inFlight.current) return;
        inFlight.current = true;
        reassign.mutate();
      }}
    >
      <RotateCcw size={14} className="shrink-0" />
      <span className="min-w-0 truncate">
        {reassign.isPending ? t("myTasksBoard.reassignMember.pending") : t("myTasksBoard.reassignMember.label")}
      </span>
    </Button>
  );
}
