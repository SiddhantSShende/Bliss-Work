import { useQuery } from "@tanstack/react-query";
import { BarChart3, Folder, Hash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import type { ChannelDTO } from "@taskboard/shared";
import { ChannelAnalyticsPanel } from "../features/ChannelAnalyticsPanel";
import { ProjectAnalyticsSection } from "../features/ProjectAnalyticsSection";
import { WorkspaceOverview } from "../features/WorkspaceOverview";
import { NavIconTile, rowClass } from "../features/ListPane";
import { useProjects } from "../features/useProjects";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

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
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader
        title={t("tasks:analyticsHub.title")}
        subtitle={t("tasks:analyticsHub.hint")}
      />
      <WorkspaceOverview />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
        <aside className="flex max-h-[28rem] w-full shrink-0 flex-col border-b border-border/60 sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r">
          <div className="flex min-h-0 flex-1 flex-col border-b border-border/60">
            <h2 className="border-b border-border/60 px-4 py-3 text-sm font-semibold text-fg">
              {t("tasks:analyticsHub.channelsTitle")}
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {isLoading ? (
                <div className="flex justify-center p-6"><Spinner /></div>
              ) : isError ? (
                <div className="space-y-2">
                  <EmptyState
                    title={t("chatList:channelsList.loadError.title")}
                    hint={t("chatList:channelsList.loadError.hint")}
                  />
                  <div className="flex justify-center">
                    <Button variant="subtle" size="sm" onClick={() => void refetch()}>
                      {t("chatList:channelsList.loadError.retry")}
                    </Button>
                  </div>
                </div>
              ) : channels?.length ? (
                <div className="space-y-1">
                  {channels.map((channel: ChannelDTO) => (
                    <NavLink
                      key={channel.id}
                      to={`/app/analytics/${channel.id}`}
                      className={({ isActive }) => rowClass(isActive)}
                    >
                      <NavIconTile><Hash size={17} /></NavIconTile>
                      <span className="truncate text-sm font-medium text-fg">{channel.name}</span>
                    </NavLink>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Hash size={22} />}
                  title={t("tasks:analyticsHub.emptyChannels.title")}
                  hint={t("tasks:analyticsHub.emptyChannels.hint")}
                />
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <h2 className="border-b border-border/60 px-4 py-3 text-sm font-semibold text-fg">
              {t("tasks:analyticsHub.projectsTitle")}
            </h2>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {projects.isLoading ? (
                <div className="flex justify-center p-6"><Spinner /></div>
              ) : projects.isError ? (
                <div className="space-y-2">
                  <EmptyState
                    title={t("tasks:analyticsHub.projectsLoadError.title")}
                    hint={t("tasks:analyticsHub.projectsLoadError.hint")}
                  />
                  <div className="flex justify-center">
                    <Button variant="subtle" size="sm" onClick={() => void projects.refetch()}>
                      {t("tasks:analyticsHub.projectsLoadError.retry")}
                    </Button>
                  </div>
                </div>
              ) : projects.data?.length ? (
                <div className="space-y-1">
                  {projects.data.map((project) => (
                    <NavLink
                      key={project.id}
                      to={`/app/analytics/projects/${project.id}`}
                      className={({ isActive }) => rowClass(isActive)}
                    >
                      <NavIconTile><Folder size={17} /></NavIconTile>
                      <span className="truncate text-sm font-medium text-fg">{project.name}</span>
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
        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {projectId ? (
            <ProjectAnalyticsSection projectId={projectId} />
          ) : channelId ? (
            <ChannelAnalyticsPanel channelId={channelId} />
          ) : (
            <EmptyState
              icon={<BarChart3 size={22} />}
              title={t("tasks:analyticsHub.noSelection.title")}
              hint={t("tasks:analyticsHub.noSelection.hint")}
            />
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
