import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import { Button, EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { CompleteProjectButton } from "../features/CompleteProjectButton";
import { MyTasksBoard } from "../features/MyTasksBoard";
import { ProjectAssignedTasks } from "./Tasks";

export function ProjectWorkspace() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.projectDetail(projectId),
    enabled: !!projectId,
  });

  if (project.isPending) {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted"><Spinner />{t("myTasksBoard.loading")}</div>;
  }
  if (project.isError || !project.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <EmptyState icon={<Folder size={24} />} title={t("projects.unavailable")} />
        <Button variant="secondary" size="sm" onClick={() => void project.refetch()}>
          {t("createTaskDialog.assign.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight text-fg">{project.data.name}</h1>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to={`/app/channels/${project.data.channelId}`}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-accent hover:bg-accent-soft"
          >
            {t("projects.openChannel")}
          </Link>
          <CompleteProjectButton project={project.data} />
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-8 overflow-auto p-4 sm:p-5">
        <section aria-labelledby="project-created-tasks">
          <h2 id="project-created-tasks" className="mb-3 text-sm font-semibold text-fg">{t("projects.createdTasks")}</h2>
          <MyTasksBoard projectId={project.data.id} />
        </section>
        <section aria-labelledby="project-assigned-tasks">
          <h2 id="project-assigned-tasks" className="mb-3 text-sm font-semibold text-fg">{t("projects.assignedTasks")}</h2>
          <ProjectAssignedTasks projectId={project.data.id} />
        </section>
      </div>
    </div>
  );
}
