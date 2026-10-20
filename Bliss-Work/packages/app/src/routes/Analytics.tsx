import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Button, PageHeader } from "@taskboard/ui";
import type { ProjectDTO } from "@taskboard/shared";
import { ChannelAnalyticsPanel } from "../features/ChannelAnalyticsPanel";
import { ProjectAnalyticsSection } from "../features/ProjectAnalyticsSection";
import { WorkspaceOverview } from "../features/WorkspaceOverview";
import { useProjects } from "../features/useProjects";

type ProjectsEntry = { kind: "project"; id: string; name: string };

export function Analytics() {
  const { t } = useTranslation(["tasks", "chatList"]);
  const navigate = useNavigate();
  const { channelId, projectId } = useParams<{ channelId?: string; projectId?: string }>();
  const projects = useProjects();

  // The channel-wise dashboard selection was removed (2026-10-20): the
  // selector now only offers Overview + projects. A pre-existing
  // /app/analytics/:channelId link (bookmarked or shared before this change)
  // still renders ChannelAnalyticsPanel below as a graceful fallback — the
  // route, panel, and backend endpoints are untouched, only unreachable from
  // this dropdown now.
  const entries = useMemo<ProjectsEntry[]>(() => {
    const projectEntries: ProjectsEntry[] = (projects.data ?? []).map((p: ProjectDTO) => ({
      kind: "project",
      id: p.id,
      name: p.name,
    }));
    return projectEntries.sort((a, b) => a.name.localeCompare(b.name));
  }, [projects.data]);

  const isErrorList = projects.isError;
  const retryList = () => {
    void projects.refetch();
  };

  // The sidebar that used to list "Overview" + every project/channel was
  // removed so the dashboard can use the full page width; project
  // selection now happens through this header dropdown instead, which drives
  // the same /app/analytics(/projects/:id) routes it used to.
  const selected = projectId ? `project:${projectId}` : "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader
        title={t("tasks:analyticsHub.title")}
        subtitle={t("tasks:analyticsHub.hint")}
        action={
          <div className="flex items-center gap-2">
            <select
              value={selected}
              onChange={(e) => {
                const value = e.target.value;
                if (!value) {
                  navigate("/app/analytics");
                  return;
                }
                const [kind, id] = value.split(":");
                navigate(kind === "project" ? `/app/analytics/projects/${id}` : `/app/analytics/${id}`);
              }}
              aria-label={t("tasks:analyticsHub.projectsTitle")}
              className="h-9 max-w-[16rem] rounded-xl border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
            >
              <option value="">{t("tasks:analyticsHub.overviewTitle")}</option>
              {entries.map((entry) => (
                <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
                  {entry.name}
                </option>
              ))}
            </select>
            {isErrorList && (
              <Button variant="subtle" size="sm" onClick={retryList}>
                {t("tasks:analyticsHub.projectsLoadError.retry")}
              </Button>
            )}
          </div>
        }
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {projectId ? (
          <ProjectAnalyticsSection projectId={projectId} />
        ) : channelId ? (
          <ChannelAnalyticsPanel channelId={channelId} />
        ) : (
          <WorkspaceOverview />
        )}
        <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-surface-1 p-4">
          <p className="text-sm text-muted">{t("tasks:analyticsHub.taskHint")}</p>
          <Button variant="subtle" size="sm" onClick={() => navigate("/app/mail")}>
            {t("tasks:analyticsHub.openMail")}
          </Button>
        </section>
      </main>
    </div>
  );
}
