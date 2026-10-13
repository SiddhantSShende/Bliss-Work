import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import { ApiError, type ProjectDTO } from "@taskboard/shared";
import { ConfirmDialog } from "./ConfirmDialog";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryKeys";

/**
 * Marks a project COMPLETED once every task filed under it is COMPLETED.
 *
 * Shown only to the project's creator or an org_admin (ProjectDTO.canComplete
 * — the server re-checks regardless, see task-svc's projects_write.py), and
 * only once the project has at least one task and none of them are pending,
 * in progress, missed, ignored, left or abandoned.
 *
 * Eligibility is read from the same whole-project completion aggregate
 * ProjectAnalyticsPanel's dashboard renders (never just the tasks currently
 * loaded on screen or on the current page) — fetched under its own query key
 * (qk.projectCompletion) so this component's plain useQuery never shares a
 * cache entry with that panel's useInfiniteQuery on the same endpoint.
 */
export function CompleteProjectButton({ project }: { project: ProjectDTO }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const canOffer = project.canComplete && project.status === "ACTIVE";
  const eligibility = useQuery({
    queryKey: qk.projectCompletion(project.id),
    queryFn: () => api.projectAnalytics(project.id, { limit: 1, offset: 0 }),
    enabled: canOffer,
  });

  const complete = useMutation({
    mutationFn: () => api.completeProject(project.id),
    onSuccess: (updated) => {
      qc.setQueryData(qk.project(project.id), updated);
      void qc.invalidateQueries({ queryKey: qk.projects });
      toast.success(t("projects.completeProject.toasts.success"));
      setOpen(false);
    },
    onError: (err) => {
      toast.error(t("projects.completeProject.toasts.failed"), {
        description: err instanceof ApiError && err.message ? err.message : String(err),
      });
    },
  });

  if (!canOffer) return null;
  const completion = eligibility.data?.completion;
  const eligible = !!completion && completion.totalUniqueTasks > 0 && completion.completedUniqueTasks === completion.totalUniqueTasks;
  if (!eligible) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        disabled={complete.isPending}
        onClick={() => setOpen(true)}
      >
        {t("projects.completeProject.button")}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => !complete.isPending && setOpen(false)}
        title={t("projects.completeProject.confirmDialog.title")}
        message={t("projects.completeProject.confirmDialog.message")}
        confirmLabel={t("projects.completeProject.confirmDialog.confirmLabel")}
        busy={complete.isPending}
        onConfirm={() => complete.mutate()}
      />
    </>
  );
}
