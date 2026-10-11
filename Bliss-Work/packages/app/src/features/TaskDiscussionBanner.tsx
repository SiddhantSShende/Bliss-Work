import { X } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

/**
 * "Discussing task: {title}" strip shown above a DM thread (while
 * useSelectedChat's focusTaskId is set) or a channel view (while its
 * `?taskId=` query param is present) — the visible task context a "Chat"
 * button opened this conversation for. Presentational only: the caller
 * resolves the title and supplies `onClear`.
 */
export function TaskDiscussionBanner({
  taskId,
  taskTitle,
  onClear,
}: {
  taskId: string;
  /** Undefined while the task detail is still loading, or if it couldn't be
   *  resolved (e.g. the viewer is neither the allocator nor an assignee) —
   *  the banner still shows, just without a title. */
  taskTitle?: string;
  onClear: () => void;
}) {
  const { t } = useTranslation("stickies");
  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-accent-soft/60 px-3 py-1.5 text-[13px]">
      <span className="min-w-0 flex-1 truncate text-fg/90">
        {t("card.discussingTask", { title: taskTitle ?? taskId })}
      </span>
      <Link
        to={`/app/mail/task/${taskId}`}
        className="shrink-0 font-semibold text-accent hover:underline"
      >
        {t("card.openTask")}
      </Link>
      <button
        onClick={onClear}
        className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
        aria-label={t("card.dismiss")}
      >
        <X size={14} />
      </button>
    </div>
  );
}
