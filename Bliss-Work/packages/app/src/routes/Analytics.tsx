import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Button, PageHeader } from "@taskboard/ui";
import type { ChannelDTO, ProjectDTO } from "@taskboard/shared";
import { ChannelAnalyticsPanel } from "../features/ChannelAnalyticsPanel";
import { ProjectAnalyticsSection } from "../features/ProjectAnalyticsSection";
import { WorkspaceOverview } from "../features/WorkspaceOverview";
import { useProjects } from "../features/useProjects";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

type ProjectsEntry = { kind: "project" | "channel"; id: string; name: string };

export function Analytics() {
  const { t } = useTranslation(["tasks", "chatList"]);
  const { api } = useRuntime();
  const navigate = useNavigate();
  const { channelId, projectId } = useParams<{ channelId?: string; projectId?: string }>();
  const { data: channels, isError, refetch } = useQuery({
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

  const isErrorList = isError || projects.isError;
  const retryList = () => {
    void refetch();
    void projects.refetch();
  };

  // The sidebar that used to list "Overview" + every project/channel was
  // removed so the dashboard can use the full page width; project/channel
  // selection now happens through this header dropdown instead, which drives
  // the same /app/analytics(/projects/:id|/:channelId) routes it used to.
  const selected = projectId ? `project:${projectId}` : channelId ? `channel:${channelId}` : "";

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
