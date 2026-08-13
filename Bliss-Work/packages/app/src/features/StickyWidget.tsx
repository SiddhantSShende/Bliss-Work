import { Check, X, Flag, LogOut, Pin, Minus } from "lucide-react";
import { Avatar, Badge } from "@taskboard/ui";
import { shouldOfferPin, type StickyTaskDTO, type TaskAction } from "@taskboard/shared";

/**
 * Presentational task card. Used inline in the Tasks/Inbox screens and as the
 * content of an Electron always-on-top sticky widget window (hence the drag
 * helpers).
 *
 * `compact` is the floating desktop note. There the action buttons render
 * ICON-ONLY (labels would crowd the small window): a SENT note shows ✓
 * Acknowledge + ✗ Ignore side by side, and the header X (ignore) is swapped for
 * a collapse-to-pill control (Ignore lives in the button row instead). The
 * roomier in-app cards (non-compact) keep labelled buttons and the header X.
 *
 * Pin model (Electron only):
 *   - `onPin` present → render a "Pin to desktop" button on ACKNOWLEDGED tasks.
 *   - `pinned` → the task is already floating; show a "Pinned" chip instead.
 *   - `locked` → this is (or mirrors) an acknowledged pinned note: the only exit
 *     is Complete, so Ignore/Leave are suppressed and `onCollapse` offers a
 *     collapse-to-pill control.
 */
export function StickyWidget({
  task,
  onAction,
  compact = false,
  onPin,
  pinned = false,
  locked = false,
  onCollapse,
}: {
  task: StickyTaskDTO;
  onAction: (action: TaskAction) => void;
  compact?: boolean;
  /** Electron-only: pin this task to the desktop (shown on ACKNOWLEDGED tasks). */
  onPin?: () => void;
  /** Whether this task is already pinned to the desktop. */
  pinned?: boolean;
  /** Locked = pinned & inescapable: hide Ignore/Leave, leave only Complete. */
  locked?: boolean;
  /** Floating note only: collapse this note to a pill. */
  onCollapse?: () => void;
}) {
  const showPin = shouldOfferPin({
    status: task.myStatus,
    canPinOnPlatform: !!onPin,
    alreadyPinned: pinned,
    locked,
  });

  // senderUsername is the email local-part, so "from j.okafor" is what a note
  // built from it alone says. This widget also renders in the desktop sticky
  // window, which has no directory query — hence the field on the DTO rather
  // than a lookup here.
  const senderName = task.senderDisplayName || task.senderUsername;

  // Whole surface is the OS-window drag region so the user can grab the note
  // from anywhere — title, body, even the empty space below the description.
  // The header buttons (X / Minus / Badge) and the action button row opt out
  // with `app-no-drag` so they remain clickable. Without this the user could
  // only drag from the small ~24px header strip, which they reasonably
  // expected to be a bug.
  return (
    <div
      className={`app-drag flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 ${
        compact ? "shadow-widget" : "shadow-soft"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Avatar name={senderName} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight text-fg">{task.title}</div>
            <div className="text-xs text-muted">from {senderName}</div>
          </div>
        </div>
        <div className="app-no-drag flex items-center gap-1.5">
          <Badge tone={task.myStatus === "ACKNOWLEDGED" ? "accent" : "neutral"}>
            {task.myStatus.toLowerCase()}
          </Badge>
          {locked || compact ? (
            // Floating note: Ignore lives in the button row, so the header gets a
            // collapse-to-pill control instead of a dismiss X. (A locked note has
            // no Ignore at all — collapse is its only non-Complete affordance.)
            onCollapse && (
              <button
                className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                title="Collapse to a pill"
                onClick={onCollapse}
              >
                <Minus size={16} />
              </button>
            )
          ) : task.actions.includes("IGNORE") ? (
            // Header X = Ignore, shown ONLY when Ignore is actually a valid
            // action (SENT). For acknowledged/terminal tasks there is no Ignore,
            // so the X is hidden rather than firing a 409.
            <button
              className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-danger"
              title="Dismiss (ignore)"
              onClick={() => onAction("IGNORE")}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>

      {task.description && (
        <p className="line-clamp-3 text-sm leading-relaxed text-fg/80">{task.description}</p>
      )}

      {/* Every action is LABELLED, including on the compact floating note. It
          used to render bare glyphs there (iconOnly={compact}), which left the
          desktop widget showing a ✓ and an ✗ with no way to tell which was
          which — the tooltip only appears if you hover and wait, and the note
          is not focusable so it cannot be reached by keyboard either. */}
      <div className="app-no-drag flex flex-wrap gap-2">
        {task.actions.includes("ACKNOWLEDGE") && !locked && (
          <ActionBtn tone="accent" label="Acknowledge" onClick={() => onAction("ACKNOWLEDGE")}>
            <Check size={15} /> Acknowledge
          </ActionBtn>
        )}
        {/* Explicit Ignore button next to Acknowledge for every SENT card. On
            the floating note the header X is a collapse control, so Ignore must
            live here; on the in-app card the header X is also Ignore, but users
            expect (and asked for) a clearly-labelled Ignore button beside
            Acknowledge rather than only a corner ✗ — so render it in both. */}
        {task.actions.includes("IGNORE") && !locked && (
          <ActionBtn tone="danger" label="Ignore" onClick={() => onAction("IGNORE")}>
            <X size={15} /> Ignore
          </ActionBtn>
        )}
        {task.actions.includes("COMPLETE") && (
          <ActionBtn tone="success" label="Complete" onClick={() => onAction("COMPLETE")}>
            <Flag size={15} /> Complete
          </ActionBtn>
        )}
        {task.actions.includes("LEAVE") && !locked && (
          <ActionBtn tone="ghost" label="Leave" onClick={() => onAction("LEAVE")}>
            <LogOut size={15} /> Leave
          </ActionBtn>
        )}
        {showPin && (
          <ActionBtn tone="ghost" onClick={() => onPin?.()}>
            <Pin size={15} /> Pin to desktop
          </ActionBtn>
        )}
        {pinned && (
          <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent-soft px-3 py-2 text-sm font-medium text-accent">
            <Pin size={15} /> Pinned to desktop
          </span>
        )}
      </div>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  tone,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone: "accent" | "success" | "ghost" | "danger";
  /** Tooltip text. The visible label is the button's own children. */
  label?: string;
}) {
  const tones = {
    accent: "bg-accent text-accent-fg hover:bg-accent-strong shadow-soft",
    success: "bg-success text-white hover:brightness-110 shadow-soft",
    ghost: "border border-border text-fg hover:bg-surface-2",
    danger: "bg-danger text-white hover:brightness-110 shadow-soft",
  };
  return (
    <button
      onClick={onClick}
      title={label}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-all active:scale-[0.98] ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
