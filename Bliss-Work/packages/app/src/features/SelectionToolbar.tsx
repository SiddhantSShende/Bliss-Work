import { useTranslation } from "react-i18next";
import { Forward, Trash2 } from "lucide-react";
import { Button } from "@taskboard/ui";

/**
 * Replaces the composer while messages are being selected.
 *
 * Sits where the composer sits because that is where actions on this
 * conversation have always lived, and because a floating bar over the thread
 * would cover the very bubbles the count refers to.
 */
export function SelectionToolbar({
  count,
  deletableCount,
  busy = false,
  onCancel,
  onDelete,
  onForward,
}: {
  count: number;
  /**
   * How many of `count` this caller may delete for everyone. Drives the
   * toolbar's wording only, never what gets sent — the bulk-delete request
   * always carries every selected id, and the server is the authority on
   * which of them it will actually delete.
   */
  deletableCount: number;
  busy?: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onForward: () => void;
}) {
  const { t } = useTranslation("chatList");
  return (
    <div className="flex items-center gap-2 border-t border-border/60 bg-surface-2/60 p-3">
      <span aria-live="polite" className="flex-1 text-sm font-medium text-fg">
        {t("selectionToolbar.selectedCount", { count })}
        {deletableCount < count && (
          <span className="ml-1 font-normal text-muted">
            {t("selectionToolbar.cannotDelete", { count: count - deletableCount })}
          </span>
        )}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        {t("common.cancel")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onForward}
        disabled={count === 0 || busy}
      >
        <Forward size={14} /> {t("selectionToolbar.forward")}
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={onDelete}
        disabled={count === 0 || busy}
      >
        <Trash2 size={14} /> {t("selectionToolbar.delete")}
      </Button>
    </div>
  );
}
