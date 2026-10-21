import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Button, PageHeader } from "@taskboard/ui";
import { ChannelAnalyticsPanel } from "../features/ChannelAnalyticsPanel";
import { ProjectAnalyticsSection } from "../features/ProjectAnalyticsSection";
import { WorkspaceOverview } from "../features/WorkspaceOverview";

export function Analytics() {
  const { t } = useTranslation(["tasks", "chatList"]);
  const navigate = useNavigate();
  const { channelId, projectId } = useParams<{ channelId?: string; projectId?: string }>();

  // The channel-wise dashboard selection was removed (2026-10-20); a
  // pre-existing /app/analytics/:channelId link (bookmarked or shared before
  // that change) still renders ChannelAnalyticsPanel below as a graceful
  // fallback — the route, panel, and backend endpoints are untouched.

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader
        title={t("tasks:analyticsHub.title")}
        subtitle={t("tasks:analyticsHub.hint")}
        action={<span className="text-sm text-fg">{t("tasks:analyticsHub.overviewTitle")}</span>}
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
