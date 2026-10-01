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
 * "Reassign" on a Completed card of the allocator's My Tasks board: the task is
 * handed back to the people who completed it. No picker — the server restores
 * exactly those assignments (task-svc `POST /tasks/{id}/reassign`), and enforces
 * that the caller is the allocator and that the task really is completed.
 */
export function ReassignTaskButton({ taskId }: { taskId: string }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  // `isPending` reaches the render a macrotask late, so `disabled` alone does not stop
  // a fast double click. The latch does, and is released when the request settles.
  const inFlight = useRef(false);
  const reassign = useMutation({
    mutationFn: () => api.reassignTask(taskId),
    onSuccess: ({ reassignedUserIds }) =>
      toast.success(t("myTasksBoard.reassign.done", { count: reassignedUserIds.length })),
    onError: (err) =>
      toast.error(t("myTasksBoard.reassign.failed"), { description: err instanceof ApiError ? err.message : String(err) }),
    onSettled: () => {
      inFlight.current = false;
      // After a failure too: a 409 means the board was stale (someone already reopened it).
      void qc.invalidateQueries({ queryKey: qk.sent });
      void qc.invalidateQueries({ queryKey: qk.assigned });
    },
  });
  return (
    <Button
      variant="secondary"
      size="sm"
      className="mt-3 self-start"
      disabled={reassign.isPending}
      onClick={() => {
        if (inFlight.current) return;
        inFlight.current = true;
        reassign.mutate();
      }}
    >
      <RotateCcw size={14} /> {reassign.isPending ? t("myTasksBoard.reassign.pending") : t("myTasksBoard.reassign.label")}
    </Button>
  );
}
