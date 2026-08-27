/**
 * The chrome shared by Chat, Notes, and Participants: one panel, three tabs,
 * rather than separately-chromed surfaces that happen to share a column.
 * CallChat, CallNotes, and CallRoster render only their own content — the tab
 * bar, export, and close controls all live here, once, so the three never
 * drift into looking like different products.
 *
 * Export is Chat/Notes only — there is nothing to download from a roster —
 * so the button is simply omitted on the Participants tab rather than wired
 * to a handler with nothing to do.
 */
import type { ReactNode } from "react";
import { Download, MessageSquare, NotebookPen, Users, X } from "lucide-react";
import { cn } from "@taskboard/ui";

type Tab = "chat" | "notes" | "participants";

export function CallSidePanel({
  active,
  onSelectTab,
  onExport,
  onClose,
  unreadChat = 0,
  className,
  children,
}: {
  active: Tab;
  onSelectTab: (tab: Tab) => void;
  /** Omitted on the Participants tab — see file doc. */
  onExport?: () => void;
  onClose: () => void;
  /** Shown on the Chat tab so switching away doesn't bury the fact that
   *  messages arrived — mirrors the sidebar's own Chats button badge. */
  unreadChat?: number;
  className?: string;
  children: ReactNode;
}) {
  const label = active === "chat" ? "chat" : active === "notes" ? "notes" : "participants";

  return (
    <aside
      aria-label={`Meeting ${label}`}
      className={cn("glass flex flex-col overflow-hidden rounded-2xl", className)}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-2 py-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Chat, notes, or participants">
          <TabButton
            active={active === "chat"}
            onClick={() => onSelectTab("chat")}
            label="Chat"
            badge={unreadChat}
          >
            <MessageSquare size={14} />
          </TabButton>
          <TabButton active={active === "notes"} onClick={() => onSelectTab("notes")} label="Notes">
            <NotebookPen size={14} />
          </TabButton>
          <TabButton active={active === "participants"} onClick={() => onSelectTab("participants")} label="People">
            <Users size={14} />
          </TabButton>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onExport && (
            <button
              type="button"
              onClick={onExport}
              title={`Save ${label} as a file`}
              aria-label={`Save ${label} as a file`}
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Download size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={`Close ${label}`}
            aria-label={`Close ${label}`}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {children}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge = 0,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-fg [filter:drop-shadow(0_0_6px_var(--color-accent))]"
          : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
      {label}
      {badge > 0 && (
        <span
          aria-hidden
          className="absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full bg-danger px-1 text-[9px] font-bold leading-[15px] text-white"
        >
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}
