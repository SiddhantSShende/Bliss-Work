import { useState } from "react";
import { Check, X, Flag, LogOut, PinOff, Minus, MessageCircle, MessageSquareText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Badge } from "@taskboard/ui";
import type { StickyTaskDTO, TaskAction } from "@taskboard/shared";
import type { ParticipantTargets } from "./AddParticipantsPicker";
import { CommentsPanel } from "./CommentsPanel";
import { TaskDeadlineProgress } from "./TaskDeadlineProgress";
import { TaskParticipantAdd, TaskParticipants } from "./TaskParticipants";
import { TaskTimes } from "./TaskTimes";
import {
  TASK_CARD_BODY,
  TASK_CARD_BODY_SLIM,
  TASK_CARD_MAIN,
  TASK_CARD_ROOT,
  TASK_CARD_SIDE,
  TASK_CARD_SIDE_FIRST,
  TASK_CARD_SIDE_SLIM,
} from "./taskCardLayout";

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
 * Pin model (Electron only): tasks pin to the desktop automatically, so the card
 * itself carries no pin controls.
 *   - `locked` → this is (or mirrors) an acknowledged pinned note: pinning only
 *     changes the note chrome; the task's valid Complete/Leave actions remain.
 *   - `onUnpin` → floating note only: an Unpin button that removes the note
 *     from the desktop popup.
 */
export function StickyWidget({
  task,
  onAction,
  busy = false,
  compact = false,
  locked = false,
  onCollapse,
  onUnpin,
  currentUserId,
  onAddParticipants,
  onWithdrawParticipant,
  participantLayout = "chips",
  onWithdrawSelf,
  headerPin,
  landscape = false,
  hideParticipants = false,
  onChat,
  chatBusy = false,
  chatUnreadCount,
}: {
  task: StickyTaskDTO;
  onAction: (action: TaskAction) => void;
  /** True while a previous onAction call is still in flight — disables every
   *  action button so a slow request can't be double-submitted. */
  busy?: boolean;
  compact?: boolean;
  /** Locked = pinned note chrome; it does not change the task's valid actions. */
  locked?: boolean;
  /** Floating note only: collapse this note to a pill. */
  onCollapse?: () => void;
  /**
   * Floating note only: unpin the NOTE from the desktop without touching the
   * TASK. Distinct from Ignore, which is a decision about the work; the task
   * stays in the Tasks list with all its actions.
   */
  onUnpin?: () => void;
  currentUserId?: string;
  onAddParticipants?: (targets: ParticipantTargets) => Promise<void>;
  onWithdrawParticipant?: (userId: string) => Promise<void>;
  participantLayout?: "chips" | "list";
  /**
   * "list" layout only: giving this shows a labelled Withdraw on the viewer's OWN
   * row of the participants list. It is not a new operation — it is called with
   * the existing self-removal action that `task.actions` currently allows:
   * IGNORE while the task is still SENT, LEAVE once it is ACKNOWLEDGED. Omitted
   * (the floating desktop note, the inbox card) the card is unchanged.
   */
  onWithdrawSelf?: (action: Extract<TaskAction, "IGNORE" | "LEAVE">) => void;
  /**
   * In-app cards only: a Pin / Unpin control for the header's top-right slot.
   * When given it REPLACES whatever would sit there (the Ignore X on a SENT
   * card, the collapse/unpin pair on a locked one), so the corner is only ever a
   * pin control. Ignore and Leave stay in the button row below. Omitted, the
   * header is exactly as it was — the floating desktop note and the inbox card
   * do not pass it.
   */
  headerPin?: React.ReactNode;
  /**
   * In-app Tasks screen only: lay the card out for a wide, short slot (see
   * taskCardLayout). Once the card itself is wide, the title, description and
   * times sit in one column and the people and actions in a second beside it, and
   * padding and gaps are tighter. Narrower than that it stacks in the usual order.
   * Off (the floating note, the mail task page) the card is exactly as it was.
   */
  landscape?: boolean;
  /**
   * Allocated to me only: leave the whole participants block off — the names, their
   * status pills, Withdraw and Add member. The task is already the viewer's, so who
   * else is on it is noise there. With `landscape` the side column also narrows to
   * just the actions (TASK_CARD_BODY_SLIM). Display only: the actions, and every
   * other card that does not pass it, are unchanged.
   */
  hideParticipants?: boolean;
  /**
   * Opens this task's chat discussion (the allocator DM, or the channel it
   * was assigned to) — navigation, not a task-state transition, so it is a
   * separate callback and never goes through `onAction`. Omitted (every
   * existing call site that hasn't been updated yet), no Chat button renders
   * and the card is exactly as it was.
   */
  onChat?: () => void;
  /** True while a previous onChat call is still resolving — mirrors `busy`. */
  chatBusy?: boolean;
  /** Unread messages in this task's discussion. Undefined renders a plain
   *  "Chat" button with no badge (discussion fetch still pending, or this
   *  call site doesn't supply one yet); 0 renders "Chat" with no badge either
   *  — the badge only appears once there is something unread to report. */
  chatUnreadCount?: number;
}) {
  const { t } = useTranslation("stickies");
  // Comments: a text-only, task-scoped discussion thread, separate from Chat
  // (onChat above). Local to the card — unlike Chat it needs no platform
  // wiring (no separate Electron window, no IPC), so it is never an opt-in
  // prop like onChat; every card that knows its own taskId can expand one.
  const [commentsOpen, setCommentsOpen] = useState(false);
  // senderUsername is the email local-part, so "from j.okafor" is what a note
  // built from it alone says. This widget also renders in the desktop sticky
  // window, which has no directory query — hence the field on the DTO rather
  // than a lookup here.
  const senderName = task.senderDisplayName || task.senderUsername;
  const activeTask = task.myStatus === "SENT" || task.myStatus === "ACKNOWLEDGED";
  const showCardAdd = participantLayout === "list" && activeTask && !!currentUserId && !!onAddParticipants;
  // Withdrawing from your own assignment is Leave once acknowledged and Ignore
  // before — the card already knows which is valid, so offer exactly that one.
  const selfWithdrawAction = task.actions.includes("LEAVE") ? "LEAVE" : task.actions.includes("IGNORE") ? "IGNORE" : null;
  const withdrawSelf = onWithdrawSelf && selfWithdrawAction ? () => onWithdrawSelf(selfWithdrawAction) : undefined;

  // The floating note is a fixed-size window that clips what does not fit, and its
  // buttons would otherwise stack into a second row there. Below 15rem of row width
  // the (decorative) icons give way instead, so the labels stay whole and the
  // buttons stay on one line. Only the compact note: an in-app card just grows.
  //
  // The in-app card has the same ladder one step lower: a label is only ever
  // squeezed once the row is narrower than the longest one, and then in order —
  // icons go (<9rem), then padding (see ActionBtn), then, below what the longest
  // label can fit in at all (<7rem), each button takes its own line and the word
  // may finally break rather than leave its button and the card. Above 9rem
  // nothing here applies, so a card that fits looks exactly as before.
  const rowIcon = compact ? "@max-[15rem]/actions:hidden" : "@max-[9rem]/actions:hidden";

  const avatar = <Avatar name={senderName} size="sm" />;
  const titleBlock = (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 line-clamp-2 font-semibold leading-tight text-fg">{task.title}</div>
        {!hideParticipants && participantLayout === "chips" && currentUserId && onAddParticipants && task.participants.some((p) => p.status === "SENT" || p.status === "ACKNOWLEDGED") && (
          <TaskParticipantAdd participants={task.participants} onAdd={onAddParticipants} />
        )}
      </div>
      {/* Unlike the title above it, kept single-line: left to wrap, a
          two-word sender name turned into three lines on a narrow note
          and the header alone ate the room the action row needed. */}
      <div className="truncate text-xs text-muted">{t("card.from", { name: senderName })}</div>
    </div>
  );
  // A missed task reads as such at a glance: danger badge here, danger "Missed" chip
  // and a danger-tinted border below.
  const badgeTone = task.myStatus === "ACKNOWLEDGED" ? "accent" : task.myStatus === "MISSED" ? "danger" : "neutral";
  const statusBadge = <Badge tone={badgeTone}>{task.myStatus.toLowerCase()}</Badge>;

  const header = headerPin ? (
    // ── Header with the Pin / Unpin control ────────────────────────────────
    // The pin takes a fixed 24px beside an avatar (28px) and the status badge
    // (up to ~112px for "acknowledged"), which in a narrow card left the title
    // with 0px. So the header is laid out by how wide THIS CARD is (an
    // `@container` query, not the viewport — it follows column count and
    // browser zoom for free), in three steps:
    //   wide   (>= 19rem)  avatar | title | badge | pin      — one row
    //   medium (>= 11rem)  avatar | title | pin, badge below the title (it may
    //                      run under the pin column too — never ellipsized here)
    //   narrow             avatar … pin, then title and badge each full width
    // The pin stays in the top-right corner in every step, and each step
    // leaves the title at least ~6.5rem (~104px) — or the whole row.
    <div className="@container shrink-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 @min-[11rem]:grid-cols-[auto_minmax(0,1fr)_auto] @min-[19rem]:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        <div className="col-start-1 row-start-1">{avatar}</div>
        <div className="col-span-2 col-start-1 row-start-2 min-w-0 @min-[11rem]:col-span-1 @min-[11rem]:col-start-2 @min-[11rem]:row-start-1 @min-[11rem]:ml-0.5">
          {titleBlock}
        </div>
        <div className="app-no-drag col-span-2 col-start-1 row-start-3 flex min-w-0 items-center @min-[11rem]:col-span-2 @min-[11rem]:col-start-2 @min-[11rem]:row-start-2 @min-[11rem]:ml-0.5 @min-[19rem]:col-span-1 @min-[19rem]:col-start-3 @min-[19rem]:row-start-1 @min-[19rem]:ml-0 @min-[19rem]:h-6">
          {/* Allowed to shrink and ellipsize: in the narrowest step it has the
              card's whole inner width, and "acknowledged" is wider than that
              in a very narrow card (e.g. 2 columns at 150% zoom). Tighter
              padding there keeps it from truncating until it truly must. */}
          <Badge
            tone={badgeTone}
            className="min-w-0 max-w-full px-1.5 tracking-normal @min-[11rem]:px-2 @min-[11rem]:tracking-wide"
          >
            <span className="truncate">{task.myStatus.toLowerCase()}</span>
          </Badge>
        </div>
        <div className="app-no-drag col-start-2 row-start-1 flex h-6 items-center justify-self-end @min-[11rem]:col-start-3 @min-[19rem]:col-start-4 @min-[19rem]:-ml-0.5">
          {headerPin}
        </div>
      </div>
    </div>
  ) : (
    <div className="flex shrink-0 items-start justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {avatar}
        {titleBlock}
      </div>
      {/* `shrink-0`: on a narrow note the long status word ("acknowledged")
          otherwise wraps this cluster onto a second line, nearly doubling the
          header and shoving the action row off the bottom of the window. The
          title beside it is already `min-w-0` + `line-clamp-2`, so it is the
          one that should give way. */}
      <div className="app-no-drag flex shrink-0 items-center gap-1.5">
        {statusBadge}
        {locked || compact ? (
          // Floating note: Ignore lives in the button row, so the header gets
          // a collapse-to-pill control — plus Unpin.
          <>
            {onCollapse && (
              <button
                className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                title={t("card.collapseToPill")}
                onClick={onCollapse}
              >
                <Minus size={16} />
              </button>
            )}
            {/* Unpinning the NOTE is not the same as ignoring the TASK: collapse
                replaced the header X, so without this a note could only be got
                rid of by completing or ignoring the task it belonged to. This
                removes the note and remembers, without touching the task. */}
            {onUnpin && (
              <button
                className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-fg"
                title={t("card.unpinNoteTitle")}
                aria-label={t("card.unpin")}
                onClick={onUnpin}
              >
                <PinOff size={16} />
              </button>
            )}
          </>
        ) : task.actions.includes("IGNORE") ? (
          // Header X = Ignore, shown ONLY when Ignore is actually a valid
          // action (SENT). For acknowledged/terminal tasks there is no Ignore,
          // so the X is hidden rather than firing a 409.
          <button
            className="app-no-drag rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            title={t("card.dismissIgnore")}
            disabled={busy}
            onClick={() => onAction("IGNORE")}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );

  // Keep the card and its actions stable while allowing the full
  // description to be read in place. `app-no-drag` is required here: the
  // whole card is an OS drag region (see below), and without opting out,
  // Electron treats a wheel/trackpad gesture over this element as window
  // drag input rather than forwarding it to the scrollable paragraph —
  // so it showed a scrollbar that never actually scrolled.
  //
  // Landscape only: `leading-normal` for `leading-relaxed`. Same font size, a
  // little less air between lines; the extra width does the rest.
  const description = task.description ? (
    <p
      className={`app-no-drag min-h-0 overflow-y-auto overscroll-contain whitespace-pre-wrap text-sm ${
        landscape ? "leading-normal" : "leading-relaxed"
      } text-fg/80 ${
        compact ? "max-h-36" : "max-h-20"
      } [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]`}
    >
      {task.description}
    </p>
  ) : null;

  // Beside the time chips, not below them: a deadline-progress ring only
  // renders when the task actually has both an assignedAt and a deadlineAt
  // (see TaskDeadlineProgress), so a task with no deadline keeps the plain
  // chip row it always had.
  const times = (
    <div className="flex min-w-0 shrink-0 items-center justify-between gap-2">
      <TaskTimes assignedAt={task.assignedAt} deadlineAt={task.deadlineAt} missedAt={task.missedAt} />
      {landscape && (
        <TaskDeadlineProgress assignedAt={task.assignedAt} deadlineAt={task.deadlineAt} missedAt={task.missedAt} />
      )}
    </div>
  );

  const participants =
    !hideParticipants && currentUserId && task.participants.length > 0 ? (
      <TaskParticipants
        participants={task.participants}
        currentUserId={currentUserId}
        allocatorId={task.senderId}
        onAdd={participantLayout === "chips" ? onAddParticipants : undefined}
        onWithdraw={onWithdrawParticipant}
        onWithdrawSelf={withdrawSelf}
        selfWithdrawDisabled={busy}
        addPlacement="name"
        layout={participantLayout}
        className={landscape ? TASK_CARD_SIDE_FIRST : undefined}
      />
    ) : null;

  const noParticipants = task.participants.length === 0;
  // With the participants block hidden (Allocated to me) there is no list for Add member
  // to hang under, so it is a full-width button directly below the action row instead —
  // reachable without bringing back the names or statuses it would extend.
  const cardAdd = showCardAdd ? (
    <div
      className={
        hideParticipants
          ? "flex min-w-0"
          : landscape
            ? `flex justify-end ${noParticipants ? TASK_CARD_SIDE_FIRST : ""}`
            : `mt-3 flex justify-end ${noParticipants ? "border-t border-border/50 pt-3" : ""}`
      }
    >
      <TaskParticipantAdd participants={task.participants} onAdd={onAddParticipants!} prominent fullWidth={hideParticipants} />
    </div>
  ) : null;

  // Every action is LABELLED, including on the compact floating note. It
  // used to render bare glyphs there (iconOnly={compact}), which left the
  // desktop widget showing a ✓ and an ✗ with no way to tell which was
  // which — the tooltip only appears if you hover and wait, and the note
  // is not focusable so it cannot be reached by keyboard either.
  // `shrink-0` keeps that fix effective: labelled buttons are taller and
  // wider than glyphs, so on a short note this row is exactly what a
  // content-sized card pushed past the window edge.
  //
  // `flex-wrap`: on a narrow card the buttons drop onto their own lines
  // instead of squeezing each other until a label ("Acknowledge") spills out
  // of its button. They stay side by side, equal width, whenever they fit.
  // A button's width is never below its own min-content (the longest word
  // plus its icon — the default `min-width: auto` of a flex item), so a word
  // is never split; `max-w-full` caps that at the card's width. Do NOT add
  // `overflow-wrap: anywhere` here: it shrinks min-content to one letter and
  // lets "Acknowledge" break mid-word.
  //
  // Landscape: once beside the main column the row sits at the foot of its column.
  const actions = (
    <div
      className={`app-no-drag @container/actions flex min-w-0 shrink-0 flex-wrap gap-2 ${
        landscape && !hideParticipants ? "@min-[34rem]/card:mt-auto" : ""
      }`}
    >
      {task.actions.includes("ACKNOWLEDGE") && !locked && (
        <ActionBtn tight={compact} tone="accent" label={t("card.acknowledge")} disabled={busy} onClick={() => onAction("ACKNOWLEDGE")}>
          <Check size={15} className={rowIcon} /> {t("card.acknowledge")}
        </ActionBtn>
      )}
      {/* Explicit Ignore button next to Acknowledge for every SENT card. On
          the floating note the header X is a collapse control, so Ignore must
          live here; on the in-app card the header X is also Ignore, but users
          expect (and asked for) a clearly-labelled Ignore button beside
          Acknowledge rather than only a corner ✗ — so render it in both. */}
      {task.actions.includes("IGNORE") && !locked && (
        <ActionBtn tight={compact} tone="danger" label={t("card.ignore")} disabled={busy} onClick={() => onAction("IGNORE")}>
          <X size={15} className={rowIcon} /> {t("card.ignore")}
        </ActionBtn>
      )}
      {task.actions.includes("COMPLETE") && (
        <ActionBtn tight={compact} tone="accent" label={t("card.complete")} disabled={busy} onClick={() => onAction("COMPLETE")}>
          <Flag size={15} className={rowIcon} /> {t("card.complete")}
        </ActionBtn>
      )}
      {task.actions.includes("LEAVE") && (
        <ActionBtn tight={compact} tone="ghost" label={t("card.leave")} disabled={busy} onClick={() => onAction("LEAVE")}>
          <LogOut size={15} className={rowIcon} /> {t("card.leave")}
        </ActionBtn>
      )}
      {onChat && (
        <ActionBtn tight={compact} tone="ghost" label={t("card.chat")} disabled={chatBusy} onClick={onChat}>
          <MessageCircle size={15} className={rowIcon} />
          {t("card.chat")}
          {!!chatUnreadCount && (
            <Badge tone="accent" className="px-1.5">
              {chatUnreadCount}
            </Badge>
          )}
        </ActionBtn>
      )}
      <ActionBtn
        tight={compact}
        tone="ghost"
        label={t("card.comments")}
        onClick={() => setCommentsOpen((v) => !v)}
      >
        <MessageSquareText size={15} className={rowIcon} />
        {t("card.comments")}
      </ActionBtn>
    </div>
  );

  const comments = commentsOpen ? (
    <CommentsPanel taskId={task.taskId} currentUserId={currentUserId} initialVisibleCount={compact ? 2 : undefined} />
  ) : null;

  // Whole surface is the OS-window drag region so the user can grab the note
  // from anywhere — title, body, even the empty space below the description.
  // The header buttons (X / Minus / Badge) and the action button row opt out
  // with `app-no-drag` so they remain clickable. Without this the user could
  // only drag from the small ~24px header strip, which they reasonably
  // expected to be a bug.
  //
  // Only the floating note (`compact`) is a drag region. On Windows Chromium
  // reports a drag region to the OS as title bar (HTCAPTION), and the OS does
  // not deliver Precision Touchpad two-finger scrolling over it, so an in-app
  // card in the main window's task list marked as one would swallow the gesture
  // (mouse wheel still worked) — and dragging a card would move the whole window.
  return (
    <div
      data-task-card=""
      className={`${compact ? "app-drag " : ""}flex min-w-0 flex-col rounded-2xl border ${
        compact ? "bg-accent-soft" : "bg-surface"
      } ${
        landscape ? `${TASK_CARD_ROOT} p-3` : "gap-3 p-4"
      } ${
        task.myStatus === "MISSED" ? "border-danger/40" : "border-border"
      } ${
        // The floating note lives in a fixed-size, user-resizable OS window
        // whose document is `overflow: hidden` — anything taller than the window
        // is not scrolled, it is silently cut off. Capping the card at the
        // window height and letting the DESCRIPTION absorb the shortfall (see
        // below) is what keeps the action row on screen; without it, shrinking
        // the note towards its minimum size clipped Acknowledge and Ignore
        // away entirely, with no scrollbar and no hint that they existed.
        //
        // `overflow-y-auto` is the Comments panel's safety net, not the
        // description's: an opened thread (composer + loaded comments +
        // expanded replies) has no shrink-to-fit sizing of its own, so on a
        // small note it can still ask for more height than max-h-full leaves.
        // Without an overflow on THIS element that excess render past the
        // card's own box with nowhere to go (the window itself can't scroll)
        // — verified with a real-browser layout probe at the pin's actual
        // 320x300 minimum, see the comment-panel review notes. A real
        // scrollbar here is strictly better than silently losing the bottom
        // of a thread the user explicitly chose to open; the always-visible
        // action row is never affected, since it renders before the panel.
        compact ? "max-h-full min-h-0 overflow-y-auto shadow-widget" : "shadow-soft"
      }`}
    >
      {landscape ? (
        <div className={hideParticipants ? TASK_CARD_BODY_SLIM : TASK_CARD_BODY}>
          <div className={TASK_CARD_MAIN}>
            {header}
            {description}
            {times}
          </div>
          <div className={hideParticipants ? TASK_CARD_SIDE_SLIM : TASK_CARD_SIDE}>
            {participants}
            {hideParticipants ? (
              <>
                {actions}
                {comments}
                {cardAdd}
              </>
            ) : (
              <>
                {cardAdd}
                {actions}
                {comments}
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          {header}
          {description}
          {times}
          {participants}
          {hideParticipants ? (
            <>
              {actions}
              {comments}
              {cardAdd}
            </>
          ) : (
            <>
              {cardAdd}
              {actions}
              {comments}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  tone,
  label,
  disabled = false,
  tight = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone: "accent" | "ghost" | "danger";
  /** Compact (floating) note only: 2px less horizontal padding when the row is under
   *  15rem, so a one-line pair still fits instead of stacking into a taller row. */
  tight?: boolean;
  /** Tooltip text. The visible label is the button's own children. */
  label?: string;
  disabled?: boolean;
}) {
  const tones = {
    accent: "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg hover:brightness-105 shadow-soft",
    ghost: "border border-border text-fg hover:bg-surface-2",
    danger: "bg-danger text-white hover:brightness-110 shadow-soft",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex max-w-full flex-1 basis-0 items-center justify-center gap-1.5 whitespace-normal rounded-xl px-2.5 py-2 text-center text-sm font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 @max-[9rem]/actions:px-1.5 @max-[7rem]/actions:basis-full @max-[7rem]/actions:[overflow-wrap:anywhere] ${tight ? "@max-[15rem]/actions:px-2" : ""} ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
