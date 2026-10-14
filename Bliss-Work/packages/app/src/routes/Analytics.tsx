import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Folder, Hash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import type { ChannelDTO, ProjectDTO } from "@taskboard/shared";
import { ChannelAnalyticsPanel } from "../features/ChannelAnalyticsPanel";
import { ProjectAnalyticsSection } from "../features/ProjectAnalyticsSection";
import { WorkspaceOverview } from "../features/WorkspaceOverview";
import { NavIconTile, rowClass } from "../features/ListPane";
import { useProjects } from "../features/useProjects";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

type ProjectsEntry = { kind: "project" | "channel"; id: string; name: string };

export function Analytics() {
  const { t } = useTranslation(["tasks", "chatList"]);
  const { api } = useRuntime();
  const navigate = useNavigate();
  const { channelId, projectId } = useParams<{ channelId?: string; projectId?: string }>();
  const { data: channels, isLoading, isError, refetch } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });
  const projects = useProjects();

  // Every project auto-provisions its own private, locked channel (see the
  // doc comment on ProjectAnalyticsPanel) — that channel is never a
  // task-assignment target in its own right, so it's excluded here to avoid
  // listing the same project twice under two different ids.
  const entries = useMemo<ProjectsEntry[]>(() => {
    const projectChannelIds = new Set((projects.data ?? []).map((p: ProjectDTO) => p.channelId));
    const projectEntries: ProjectsEntry[] = (projects.data ?? []).map((p: ProjectDTO) => ({
      kind: "project",
      id: p.id,
      name: p.name,
    }));
    const channelEntries: ProjectsEntry[] = (channels ?? [])
      .filter((c: ChannelDTO) => !projectChannelIds.has(c.id))
      .map((c: ChannelDTO) => ({ kind: "channel", id: c.id, name: c.name }));
    return [...projectEntries, ...channelEntries].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects.data, channels]);

  const isLoadingList = isLoading || projects.isLoading;
  const isErrorList = isError || projects.isError;
  const retryList = () => {
    void refetch();
    void projects.refetch();
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader
        title={t("tasks:analyticsHub.title")}
        subtitle={t("tasks:analyticsHub.hint")}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
        <aside className="flex max-h-[28rem] w-full shrink-0 flex-col border-b border-border/60 sm:max-h-none sm:h-full sm:w-72 sm:border-b-0 sm:border-r">
          <div className="shrink-0 border-b border-border/60 p-2">
            <NavLink to="/app/analytics" end className={({ isActive }) => rowClass(isActive)}>
              <NavIconTile><BarChart3 size={17} /></NavIconTile>
              <span className="truncate text-sm font-medium text-fg">
                {t("tasks:analyticsHub.overviewTitle")}
              </span>
            </NavLink>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <h2 className="border-b border-border/60 px-4 py-3 text-sm font-semibold text-fg">
              {t("tasks:analyticsHub.projectsTitle")}
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {isLoadingList ? (
                <div className="flex justify-center p-6"><Spinner /></div>
              ) : isErrorList ? (
                <div className="space-y-2">
                  <EmptyState
                    title={t("tasks:analyticsHub.projectsLoadError.title")}
                    hint={t("tasks:analyticsHub.projectsLoadError.hint")}
                  />
                  <div className="flex justify-center">
                    <Button variant="subtle" size="sm" onClick={retryList}>
                      {t("tasks:analyticsHub.projectsLoadError.retry")}
                    </Button>
                  </div>
                </div>
              ) : entries.length ? (
                <div className="space-y-1">
                  {entries.map((entry) => (
                    <NavLink
                      key={`${entry.kind}:${entry.id}`}
                      to={
                        entry.kind === "project"
                          ? `/app/analytics/projects/${entry.id}`
                          : `/app/analytics/${entry.id}`
                      }
                      className={({ isActive }) => rowClass(isActive)}
                    >
                      <NavIconTile>
                        {entry.kind === "project" ? <Folder size={17} /> : <Hash size={17} />}
                      </NavIconTile>
                      <span className="truncate text-sm font-medium text-fg">{entry.name}</span>
                    </NavLink>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Folder size={22} />}
                  title={t("tasks:analyticsHub.emptyProjects.title")}
                  hint={t("tasks:analyticsHub.emptyProjects.hint")}
                />
              )}
            </div>
          </div>
        </aside>
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
    </div>
  );
}
