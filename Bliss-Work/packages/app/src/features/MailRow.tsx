import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import { ListTodo, Mail, MessageCircle, X, Trash2, Flag, Check, Undo2 } from "lucide-react";
import { Avatar, Badge } from "@taskboard/ui";
import type { InboxItemDTO } from "@taskboard/shared";
import { listTime, splitMailPreview } from "../lib/mailView";
import { useUserLabels } from "../lib/userLabel";

/**
 * Single row in Mail's message column. Branches on item_kind:
 *   MAIL   → an email, laid out the way a mail client lays one out: sender and
 *            time on the top line, the subject beneath it, then how the body
 *            starts. Subject and snippet arrive already joined in `preview`
 *            (the server builds it; the body is never in the feed), so
 *            splitting them is the only work the row does.
 *   THREAD → the same shape with the last message where the subject sits.
 *   TASK   → task title + acknowledge / complete / ignore controls (the actual
 *            mutations call task-svc). Still rendered here for deep links and
 *            for any surface that passes one, though the mail list itself no
 *            longer lists tasks.
 *
 * Unread is carried by the accent dot in the left gutter and by the weight of
 * the subject — the two signals every mail list uses — rather than by a count
 * on the avatar. A count only says something a dot does not when a THREAD has
 * collected several replies, so that is the one case it still appears in.
 */
export function MailRow({
  item,
  search = "",
  onIgnore,
  onRestore,
  onDismiss,
  onAcknowledge,
  onComplete,
}: {
  item: InboxItemDTO;
  /** The list's own query string (folder + person), carried into the reading
   *  pane so closing what was opened returns to the same filtered list. */
  search?: string;
  /** Hide for the owner. THREAD → always; TASK → only valid from SENT (the
   *  parent withholds this for ACKNOWLEDGED/locked rows). Shows the X button. */
  onIgnore?: (itemKind: string, refId: string) => void;
  /** Deleted Items only: put this mail back where it came from. The parent
   *  passes this INSTEAD of onIgnore there — a deleted row cannot be deleted
   *  again, so the two are never both offered. */
  onRestore?: (refId: string) => void;
  /** Sender-side delete on own messages — shows the trash button only when
   *  there's currently a sender-side last message in the preview. */
  onDismiss?: (refId: string) => void;
  /** TASK rows only: acknowledge a SENT task (accept it). Shows the ✓ button. */
  onAcknowledge?: (refId: string) => void;
  /** TASK rows only: complete an ACKNOWLEDGED task. Shows the flag button. */
  onComplete?: (refId: string) => void;
}) {
  const { nameOf, emailOf } = useUserLabels();
  const isTask = item.itemKind === "TASK";
  const isMail = item.itemKind === "MAIL";
  const pathname = isTask
    ? `/app/mail/task/${item.refId}`
    : isMail
      ? `/app/mail/message/${item.refId}`
      : `/app/mail/thread/${item.refId}`;
  // A row is identified by the PERSON, the way every other chat surface in the
  // app identifies one — not by their address. Mail is styled after an email
  // client and used to print the address here, which left the same
  // colleague reading as "j.okafor@acme.com" in the list and "Jane Okafor" in
  // the thread header one click away.
  //
  // `peerUsername` is only the email local-part (see lib/userLabel), so it can
  // never be rendered on its own; the real name is joined in from the org
  // directory, with the handle kept as the fallback for anyone no longer
  // listed there. The name also drives the avatar's initials — "j.okafor"
  // would render "JO" from the wrong halves.
  //
  // The one row with no person to name is mail from OUTSIDE the org: there is
  // no local account behind that address, so the directory has nothing to join
  // and nameOf would fall back to a handle that does not exist. "External
  // sender" is the honest label — the address itself is on the detail view.
  const peerName =
    isMail && !item.peerUserId ? "External sender" : nameOf(item.peerUserId, item.peerUsername);
  // The address stays reachable on hover. It is what a mail row is really
  // addressed to, and dropping it entirely would lose the one thing the email
  // framing did buy — but it is a detail, not the row's identity.
  const peerEmail = emailOf(item.peerUserId, item.peerUsername);
  const isUnread = item.unreadCount > 0;
  const mail = isMail ? splitMailPreview(item.preview) : null;
  const headline = isTask
    ? item.preview || "(untitled task)"
    : mail
      ? mail.subject || "(no subject)"
      : item.preview || "(no preview)";

  return (
    <NavLink
      to={{ pathname, search }}
      className={({ isActive }) =>
        // Rows are separated by a hairline rather than by gaps, the way a mail
        // list is — but the line is drawn by the row itself (an `after` rule)
        // so it can disappear under the hover and selection fills without
        // leaving a seam across them.
        `group relative block rounded-xl px-3 py-3 transition-colors ${
          isActive
            ? "bg-accent-soft ring-1 ring-accent/20"
            : "after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border/45 after:transition-opacity hover:bg-surface-2/70 hover:after:opacity-0"
        }`
      }
    >
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14 }}
        className="flex items-start gap-3"
      >
        {/* Unread gutter. Always occupies its width so nothing shifts sideways
            when a row is read. */}
        <span
          aria-hidden
          className={`mt-3.5 h-2 w-2 shrink-0 rounded-full ${isUnread ? "bg-accent" : "bg-transparent"}`}
        />
        {isTask ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <ListTodo size={16} />
          </div>
        ) : isMail && !item.peerUserId ? (
          // No account, so no initials worth deriving — the envelope says
          // "this came from outside" more clearly than a generated monogram.
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            <Mail size={16} />
          </div>
        ) : (
          <Avatar name={peerName} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-sm ${isUnread ? "font-semibold text-fg" : "font-medium text-fg/90"}`}
              title={isTask ? undefined : peerEmail}
            >
              {isTask ? "Task" : peerName}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">
              {listTime(item.lastEventAt)}
            </span>
          </div>

          <div
            className={`mt-0.5 truncate text-[13px] ${isUnread ? "font-semibold text-fg" : "text-fg/80"}`}
          >
            {headline}
          </div>

          {mail?.snippet && (
            <div className="mt-0.5 truncate text-xs text-muted">{mail.snippet}</div>
          )}

          {(item.statusBadge || (!isMail && !isTask) || item.unreadCount > 1) && (
            <div className="mt-1.5 flex items-center gap-1.5">
              {item.statusBadge && (
                <Badge tone={statusTone(item.statusBadge)}>{item.statusBadge.toLowerCase()}</Badge>
              )}
              {!isMail && !isTask && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted/80">
                  <MessageCircle size={10} /> thread
                </span>
              )}
              {item.unreadCount > 1 && (
                <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
                  {item.unreadCount > 9 ? "9+" : item.unreadCount} new
                </span>
              )}
            </div>
          )}
        </div>

        {/* Row actions. Kept out of the way until the row is pointed at — on a
            list this dense a permanent column of glyphs reads as clutter — but
            never hidden from the keyboard or from touch, which has no hover. */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          {/* TASK actions mirror the assignee state machine: SENT → Acknowledge,
              ACKNOWLEDGED → Complete. Ignore is valid only from SENT. */}
          {isTask && item.statusBadge === "SENT" && onAcknowledge && (
            <Quick
              icon={<Check size={14} />}
              title="Acknowledge — accept this task"
              label="Acknowledge"
              tone="accent"
              onClick={(e) => { e.preventDefault(); onAcknowledge(item.refId); }}
            />
          )}
          {isTask && item.statusBadge === "ACKNOWLEDGED" && onComplete && (
            <Quick
              icon={<Flag size={14} />}
              title="Mark complete"
              label="Complete"
              tone="success"
              onClick={(e) => { e.preventDefault(); onComplete(item.refId); }}
            />
          )}
          {onRestore && isMail && (
            <Quick
              icon={<Undo2 size={14} />}
              title="Restore — puts this mail back in the folder it came from"
              label="Restore"
              tone="accent"
              onClick={(e) => { e.preventDefault(); onRestore(item.refId); }}
            />
          )}
          {onIgnore && (!isTask || item.statusBadge === "SENT") && (
            <Quick
              icon={isMail ? <Trash2 size={14} /> : <X size={14} />}
              title={
                isMail
                  ? "Delete — removes your copy only; nobody else's is affected"
                  : isTask
                    ? "Ignore — remove from your mailbox"
                    : "Ignore — hides for both"
              }
              label={isMail ? "Delete" : "Ignore"}
              hideLabel={!isTask}
              tone="danger"
              onClick={(e) => { e.preventDefault(); onIgnore(item.itemKind, item.refId); }}
            />
          )}
          {/* Sender-side delete of one's own MESSAGE. Threads only: it posts to
              /messages/{id}/dismiss, and a mail's refId is not a message id. */}
          {onDismiss && !isTask && !isMail && (
            <Quick
              icon={<Trash2 size={14} />}
              title="Delete from your mailbox"
              label="Delete from your mailbox"
              hideLabel
              tone="muted"
              onClick={(e) => { e.preventDefault(); onDismiss(item.refId); }}
            />
          )}
        </div>
      </motion.div>
    </NavLink>
  );
}

function statusTone(s: string): "accent" | "success" | "neutral" {
  if (s === "SEEN" || s === "COMPLETED") return "success";
  if (s === "ACKNOWLEDGED" || s === "DELIVERED") return "accent";
  return "neutral";
}

function Quick({
  icon,
  title,
  label,
  hideLabel = false,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  /**
   * The action's name. Always the accessible name; also rendered beside the
   * icon unless `hideLabel` says otherwise, which is what tells the task
   * state-machine actions apart — a ✓ and an ✗ do not say "Acknowledge" and
   * "Ignore" to anyone who hasn't been told.
   */
  label: string;
  /** Icon only. For Delete, whose icon is conventional and whose row is full. */
  hideLabel?: boolean;
  tone: "muted" | "danger" | "accent" | "success";
  onClick: (e: React.MouseEvent) => void;
}) {
  const tones = {
    muted: "text-muted hover:bg-surface hover:text-fg",
    danger: "text-muted hover:bg-surface hover:text-danger",
    accent: "text-accent hover:bg-accent-soft",
    success: "text-success hover:bg-success/10",
  };
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={label}
      className={`inline-flex items-center gap-1 rounded-lg p-1.5 text-[11px] font-medium transition-colors ${tones[tone]}`}
    >
      {icon}
      {!hideLabel && label}
    </button>
  );
}
