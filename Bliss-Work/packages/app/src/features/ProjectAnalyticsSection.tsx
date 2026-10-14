import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import { Button, EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ProjectAnalyticsPanel } from "./ProjectAnalyticsPanel";

/**
 * Analytics' project-selected pane. Resolves the project's name (so the
 * dashboard clearly identifies which project it belongs to) and otherwise
 * just hosts the real ProjectAnalyticsPanel — same component, same data, that
 * used to be inlined on the Tasks project page.
 */
export function ProjectAnalyticsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.projectDetail(projectId),
    enabled: !!projectId,
  });

  if (project.isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="space-y-2">
        <EmptyState icon={<Folder size={22} />} title={t("projects.unavailable")} hint="" />
        <div className="flex justify-center">
          <Button variant="subtle" size="sm" onClick={() => void project.refetch()}>
            {t("analytics.project.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("analytics.project.title")}</p>
        <h1 className="truncate text-base font-semibold tracking-tight text-fg">{project.data.name}</h1>
      </header>
      <ProjectAnalyticsPanel projectId={project.data.id} />
    </div>
  );
}
