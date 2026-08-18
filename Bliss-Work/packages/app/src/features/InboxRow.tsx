import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import { ListTodo, Mail, MailOpen, MessageCircle, Reply, X, Trash2, Flag, Check } from "lucide-react";
import { Avatar, Badge } from "@taskboard/ui";
import type { InboxItemDTO } from "@taskboard/shared";
import { relative } from "../lib/chatFormat";
import { useUserLabels } from "../lib/userLabel";

/**
 * Single row in the unified Inbox feed. Branches on item_kind:
 *   MAIL   → an email. Subject and snippet arrive already joined in `preview`
 *            (the server builds it; the body is never in the feed), so the row
 *            renders sender + preview and nothing else has to be fetched to
 *            draw the list.
 *   THREAD → email-style row with the peer's NAME, preview, unread pill,
 *            status badge for sender-side rows.
 *   TASK   → row with task title + acknowledge / complete / ignore / leave
 *            controls (the actual mutations call task-svc). Still rendered
 *            here for deep links and for any surface that passes one, though
 *            the Inbox feed itself no longer lists tasks.
 *
 * The row is wrapped in a NavLink that routes into the detail pane.
 */
export function InboxRow({
  item,
  onIgnore,
  onDismiss,
  onAcknowledge,
  onComplete,
}: {
  item: InboxItemDTO;
  /** Hide for the owner. THREAD → always; TASK → only valid from SENT (the
   *  parent withholds this for ACKNOWLEDGED/locked rows). Shows the X button. */
  onIgnore?: (itemKind: string, refId: string) => void;
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
  const to = isTask
    ? `/app/inbox/task/${item.refId}`
    : isMail
      ? `/app/inbox/mail/${item.refId}`
      : `/app/inbox/thread/${item.refId}`;
  // A row is identified by the PERSON, the way every other chat surface in the
  // app identifies one — not by their address. The Inbox is styled after an
  // email client and used to print the address here, which left the same
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
    isMail && !item.peerUserId
      ? "External sender"
      : nameOf(item.peerUserId, item.peerUsername);
  // The address stays reachable on hover. It is what an Inbox row is really
  // addressed to, and dropping it entirely would lose the one thing the email
  // framing did buy — but it is a detail, not the row's identity.
  const peerEmail = emailOf(item.peerUserId, item.peerUsername);
  const isUnread = item.unreadCount > 0;

  return (
    <NavLink to={to} className={({ isActive }) =>
      `block rounded-xl px-2 py-2 transition-colors ${isActive ? "bg-surface-2" : "hover:bg-surface-2/60"}`}>
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14 }}
        className="flex items-start gap-3"
      >
        <div className="relative shrink-0">
          {isTask ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
              <ListTodo size={16} />
            </div>
          ) : isMail && !item.peerUserId ? (
            // No account, so no initials worth deriving — the envelope says
            // "this came from outside" more clearly than a generated monogram.
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Mail size={16} />
            </div>
          ) : (
            <Avatar name={peerName} size="sm" />
          )}
          {isUnread && (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
              {item.unreadCount > 9 ? "9+" : item.unreadCount}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className={`truncate ${isUnread ? "font-semibold text-fg" : "text-fg/90"}`}>
              {isTask ? (
                <span className="inline-flex items-center gap-1">
                  <ListTodo size={13} /> {item.preview || "(untitled task)"}
                </span>
              ) : (
                <span title={peerEmail}>{peerName}</span>
              )}
            </div>
            <span className="shrink-0 text-[10px] text-muted">{relative(item.lastEventAt)}</span>
          </div>
          {!isTask && (
            <div className={`truncate text-xs ${isUnread ? "text-fg/80" : "text-muted"}`}>
              {item.preview || (isMail ? "(no subject)" : "(no preview)")}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1">
            {item.statusBadge && (
              <Badge tone={statusTone(item.statusBadge)}>{item.statusBadge.toLowerCase()}</Badge>
            )}
            {isMail ? (
              <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted/80">
                {isUnread ? <Mail size={10} /> : <MailOpen size={10} />} mail
              </span>
            ) : (
              !isTask && (
                <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted/80">
                  <MessageCircle size={10} /> thread
                </span>
              )
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isTask && !isMail && (
            <Quick
              icon={<Reply size={14} />}
              title="Reply (opens thread)"
              tone="muted"
              onClick={(e) => { e.preventDefault(); /* NavLink will route on click anyway */ }}
            />
          )}
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
          {onIgnore && (!isTask || item.statusBadge === "SENT") && (
            <Quick
              icon={<X size={14} />}
              title={
                isMail
                  ? "Remove from your Inbox — the sender's copy is unaffected"
                  : isTask
                    ? "Ignore — remove from inbox"
                    : "Ignore — hides for both"
              }
              label={isMail ? "Delete" : "Ignore"}
              tone="danger"
              onClick={(e) => { e.preventDefault(); onIgnore(item.itemKind, item.refId); }}
            />
          )}
          {/* Sender-side delete of one's own MESSAGE. Threads only: it posts to
              /messages/{id}/dismiss, and a mail's refId is not a message id. */}
          {onDismiss && !isTask && !isMail && (
            <Quick
              icon={<Trash2 size={14} />}
              title="Delete from your inbox"
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
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  /**
   * Visible text beside the icon. Supplied for the task state-machine actions,
   * which are otherwise indistinguishable glyphs — a ✓ and an ✗ do not say
   * "Acknowledge" and "Ignore" to anyone who hasn't been told. Omitted for
   * Reply and Delete, whose icons are conventional and whose row has no room.
   */
  label?: string;
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
      aria-label={label ?? title}
      className={`inline-flex items-center gap-1 rounded-lg p-1 text-[11px] font-medium transition-colors ${tones[tone]}`}
    >
      {icon}
      {label}
    </button>
  );
}
