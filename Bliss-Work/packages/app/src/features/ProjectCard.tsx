import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Folder, ChevronRight } from "lucide-react";
import { Badge, GlassCard } from "@taskboard/ui";
import type { ProjectDTO } from "@taskboard/shared";
import { TASK_CARD_ROOT } from "./taskCardLayout";

/**
 * A completed project rendered in the same card grid as task cards
 * (TASK_CARD_GRID), but visually distinct via the "Completed" success badge
 * instead of a task's action row — there is nothing to acknowledge/complete
 * on a project, only to open its channel/tasks.
 */
export function ProjectCard({ project }: { project: ProjectDTO }) {
  const { t } = useTranslation("tasks");
  const navigate = useNavigate();
  return (
    <GlassCard
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app/tasks/projects/${project.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") navigate(`/app/tasks/projects/${project.id}`);
      }}
      className={`${TASK_CARD_ROOT} flex min-w-0 cursor-pointer items-center justify-between gap-3 p-4 transition-colors hover:bg-surface-2/60`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Folder size={18} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{project.name}</p>
          <Badge tone="success" className="mt-1">{t("projects.completedBadge")}</Badge>
        </div>
      </div>
      <ChevronRight size={16} className="shrink-0 text-muted" />
    </GlassCard>
  );
}
