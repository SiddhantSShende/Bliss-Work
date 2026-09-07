import { Check, X, Flag, LogOut, Pin, Minus } from "lucide-react";
import { Avatar, Badge } from "@taskboard/ui";
import { shouldOfferPin, type StickyTaskDTO, type TaskAction } from "@taskboard/shared";

/**
 * Presentational task card. Used inline in the Tasks/Inbox screens and as the
 * content of an Electron always-on-top sticky widget window (hence the drag
 * helpers).
 *
 * `compact` is the floating desktop note. Its actions are LABELLED, exactly as
 * the in-app cards are — a SENT note shows "✓ Acknowledge" and "✗ Ignore" side
 * by side — and the header X (ignore) is swapped for a collapse-to-pill control,
 * since Ignore lives in the button row instead. The non-compact in-app cards
 * keep the header X as well.
 *
 * Compact also caps the card at its container's height, because that container
 * is an OS window the user can resize and whose document cannot scroll. See the
 * class list below.
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
  busy = false,
  compact = false,
  onPin,
  pinned = false,
  locked = false,
  onCollapse,
  onDismiss,
}: {
  task: StickyTaskDTO;
  onAction: (action: TaskAction) => void;
  /** True while a previous onAction call is still in flight — disables every
   *  action button so a slow request can't be double-submitted. */
  busy?: boolean;
  compact?: boolean;
  /** Electron-only: pin this task to the desktop (shown on ACKNOWLEDGED tasks). */
  onPin?: () => void;
  /** Whether this task is already pinned to the desktop. */
  pinned?: boolean;
  /** Locked = pinned & inescapable: hide Ignore/Leave, leave only Complete. */
  locked?: boolean;
  /** Floating note only: collapse this note to a pill. */
  onCollapse?: () => void;
  /**
   * Floating note only: clear the NOTE without touching the TASK. Distinct from
   * Ignore, which is a decision about the work; this just says "I've seen it".
   */
  onDismiss?: () => void;
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
        // The floating note lives in a fixed-size, user-resizable OS window
        // whose document is `overflow: hidden` — anything taller than the window
        // is not scrolled, it is silently cut off. Capping the card at the
        // window height and letting the DESCRIPTION absorb the shortfall (see
        // below) is what keeps the action row on screen; without it, shrinking
        // the note towards its minimum size clipped Acknowledge and Ignore
        // away entirely, with no scrollbar and no hint that they existed.
        compact ? "max-h-full min-h-0 shadow-widget" : "shadow-soft"
      }`}
    >
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Avatar name={senderName} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight text-fg">{task.title}</div>
            {/* Truncated like the title above it. Left to wrap, a two-word
                sender name turned into three lines on a narrow note and the
                header alone ate the room the action row needed. */}
            <div className="truncate text-xs text-muted">from {senderName}</div>
          </div>
        </div>
        {/* `shrink-0`: on a narrow note the long status word ("acknowledged")
            otherwise wraps this cluster onto a second line, nearly doubling the
            header and shoving the action row off the bottom of the window. The
            title beside it is already `min-w-0` + `truncate`, so it is the one
            that should give way. */}
        <div className="app-no-drag flex shrink-0 items-center gap-1.5">
          <Badge tone={task.myStatus === "ACKNOWLEDGED" ? "accent" : "neutral"}>
            {task.myStatus.toLowerCase()}
          </Badge>
          {locked || compact ? (
            // Floating note: Ignore lives in the button row, so the header gets
            // a collapse-to-pill control — plus, now, a real dismiss.
            <>
              {onCollapse && (
                <button
                  className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                  title="Collapse to a pill"
                  onClick={onCollapse}
                >
                  <Minus size={16} />
                </button>
              )}
              {/* Clearing the NOTE is not the same as ignoring the TASK, and
                  the note used to offer neither: collapse replaced the X, so a
                  note the user had read could only be got rid of by completing
                  or ignoring the task it belonged to. This closes it and
                  remembers, without touching the commitment. */}
              {onDismiss && (
                <button
                  className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                  title="Clear this note (the task stays)"
                  aria-label="Clear this note"
                  onClick={onDismiss}
                >
                  <X size={16} />
                </button>
              )}
            </>
          ) : task.actions.includes("IGNORE") ? (
            // Header X = Ignore, shown ONLY when Ignore is actually a valid
            // action (SENT). For acknowledged/terminal tasks there is no Ignore,
            // so the X is hidden rather than firing a 409.
            <button
              className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
              title="Dismiss (ignore)"
              disabled={busy}
              onClick={() => onAction("IGNORE")}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>

      {/* The only part of the card that can afford to lose room: a shortened
          description is a nuisance, a missing Acknowledge button is a dead end.
          Two lines on the floating note rather than three, so the labelled
          action row fits the default window with the clamp landing on a line
          boundary (with its ellipsis) instead of slicing one in half; `min-h-0`
          lets even those two lines give way if the user shrinks the note
          further. Three lines still on the roomier in-app cards. */}
      {task.description && (
        <p
          className={`min-h-0 text-sm leading-relaxed text-fg/80 ${
            compact ? "line-clamp-2" : "line-clamp-3"
          }`}
        >
          {task.description}
        </p>
      )}

      {/* Every action is LABELLED, including on the compact floating note. It
          used to render bare glyphs there (iconOnly={compact}), which left the
          desktop widget showing a ✓ and an ✗ with no way to tell which was
          which — the tooltip only appears if you hover and wait, and the note
          is not focusable so it cannot be reached by keyboard either.
          `shrink-0` keeps that fix effective: labelled buttons are taller and
          wider than glyphs, so on a short note this row is exactly what a
          content-sized card pushed past the window edge. */}
      <div className="app-no-drag flex shrink-0 flex-wrap gap-2">
        {task.actions.includes("ACKNOWLEDGE") && !locked && (
          <ActionBtn tone="accent" label="Acknowledge" disabled={busy} onClick={() => onAction("ACKNOWLEDGE")}>
            <Check size={15} /> Acknowledge
          </ActionBtn>
        )}
        {/* Explicit Ignore button next to Acknowledge for every SENT card. On
            the floating note the header X is a collapse control, so Ignore must
            live here; on the in-app card the header X is also Ignore, but users
            expect (and asked for) a clearly-labelled Ignore button beside
            Acknowledge rather than only a corner ✗ — so render it in both. */}
        {task.actions.includes("IGNORE") && !locked && (
          <ActionBtn tone="danger" label="Ignore" disabled={busy} onClick={() => onAction("IGNORE")}>
            <X size={15} /> Ignore
          </ActionBtn>
        )}
        {task.actions.includes("COMPLETE") && (
          <ActionBtn tone="success" label="Complete" disabled={busy} onClick={() => onAction("COMPLETE")}>
            <Flag size={15} /> Complete
          </ActionBtn>
        )}
        {task.actions.includes("LEAVE") && !locked && (
          <ActionBtn tone="ghost" label="Leave" disabled={busy} onClick={() => onAction("LEAVE")}>
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
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone: "accent" | "success" | "ghost" | "danger";
  /** Tooltip text. The visible label is the button's own children. */
  label?: string;
  disabled?: boolean;
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
      disabled={disabled}
      title={label}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
