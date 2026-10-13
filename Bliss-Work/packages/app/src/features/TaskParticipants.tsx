import { useState } from "react";
import { Plus, UserMinus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, IconButton } from "@taskboard/ui";
import type { TaskParticipantDTO } from "@taskboard/shared";
import { Modal } from "./Modal";
import { AddParticipantsPicker, type ParticipantTargets } from "./AddParticipantsPicker";

/** Only an open assignment can be extended or withdrawn; COMPLETED, LEFT and
 *  IGNORED are history. The server enforces the same rule (participants.py). */
export const isActive = (participant: TaskParticipantDTO) => participant.status === "SENT" || participant.status === "ACKNOWLEDGED";

export function TaskParticipants({
  participants,
  currentUserId,
  allocatorId,
  onAdd,
  onWithdraw,
  onWithdrawSelf,
  selfWithdrawDisabled = false,
  addPlacement = "participants",
  layout = "chips",
  className = "mt-3 border-t border-border/50 pt-3",
}: {
  participants: TaskParticipantDTO[];
  currentUserId: string;
  allocatorId: string;
  onAdd?: (targets: ParticipantTargets) => Promise<void>;
  onWithdraw?: (userId: string) => Promise<void>;
  /** Withdraw from your OWN open assignment: a button on the current user's own
   *  row, "list" layout only. Distinct from `onWithdraw`, which is the
   *  allocator removing someone else. The caller maps it onto the existing
   *  self-removal action (Ignore before acknowledging, Leave after), so this
   *  component adds no operation of its own. */
  onWithdrawSelf?: () => void;
  /** True while that action is in flight, so it cannot be submitted twice. */
  selfWithdrawDisabled?: boolean;
  addPlacement?: "name" | "participants";
  /** "chips" (default) is the compact pill row with an icon-only Withdraw, for
   *  the small sticky note. "list" is one row per person with a labelled
   *  Withdraw button and an "Add member" button underneath, for the
   *  allocator's My Tasks card, where the controls have to be discoverable. */
  layout?: "chips" | "list";
  /** Outer spacing and divider. The default is the stacked card's "rule above, room
   *  around"; a card that lays this block out beside its main column passes its own. */
  className?: string;
}) {
  const { t } = useTranslation("tasks");
  const [busy, setBusy] = useState(false);
  const active = participants.some((participant) => participant.userId === currentUserId && isActive(participant));
  const hasOpenAssignment = participants.some(isActive);
  const canAdd = !!onAdd && hasOpenAssignment && (currentUserId === allocatorId || active);
  const canWithdraw = currentUserId === allocatorId && !!onWithdraw;
  const showAdd = canAdd && addPlacement === "participants";
  // Withdrawing yourself is Leave, which is a different action with its own button.
  const removable = (participant: TaskParticipantDTO) =>
    canWithdraw && participant.userId !== currentUserId && isActive(participant);
  // The mirror image of `removable`: only the viewer's own, still-open row.
  const selfWithdrawable = (participant: TaskParticipantDTO) =>
    !!onWithdrawSelf && participant.userId === currentUserId && isActive(participant);

  // Called fire-and-forget from onClick, so a rejection has nowhere to go: it
  // would surface as an unhandled promise rejection. Every caller's mutation
  // already reports its own failure (the onError toast), so it is dropped here.
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch {
      // Reported by the caller; the buttons re-enable below so it can be retried.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">
        {/* min-w-0 + truncate rather than shrink-0: at the narrowest a card gets (a 320px window at 200% zoom) a rigid label was wider than the card's own inner width. */}
        <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted">{t("participants.label")}</span>
        {showAdd && layout === "chips" && <TaskParticipantAdd participants={participants} onAdd={onAdd!} />}
      </div>
      {layout === "list" ? (
        <ul className="mt-2 flex min-w-0 flex-col divide-y divide-border/50">
          {participants.map((participant) => {
            const name = participant.username || participant.userId;
            const withdrawLabel = t("participants.withdrawUser", { name });
            return (
              <li key={participant.userId} className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1.5 first:pt-0 last:pb-0">
                {/* A floor on the name's width, so in a narrow card the Withdraw button
                    wraps onto its own line instead of squeezing the name to nothing. */}
                <span className="inline-flex min-w-[min(8rem,100%)] max-w-full flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-fg">
                  <span className="min-w-0 truncate">{name}</span>
                  {/* Can give way and ellipsize, so a long status word never leaves a card
                      narrower than it. Unchanged wherever the badge fits. */}
                  <Badge tone={participantTone(participant.status)} className="min-w-0 max-w-full">
                    <span className="truncate">{participant.status.toLowerCase()}</span>
                  </Badge>
                </span>
                {removable(participant) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="max-w-full text-danger"
                    aria-label={withdrawLabel}
                    disabled={busy}
                    onClick={() => void run(() => onWithdraw!(participant.userId))}
                  >
                    {/* Names the person on screen as well as to a screen reader (the visible
                        text IS the accessible name): on a card where the viewer also has their
                        own plain "Withdraw", the two must not read alike. One truncating span, so
                        a long name ends in an ellipsis and "Withdraw" itself is never lost. */}
                    <UserMinus size={14} className="shrink-0" />
                    <span className="min-w-0 truncate">{withdrawLabel}</span>
                  </Button>
                )}
                {selfWithdrawable(participant) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="max-w-full text-danger"
                    aria-label={t("participants.withdrawSelf")}
                    disabled={selfWithdrawDisabled}
                    onClick={() => onWithdrawSelf!()}
                  >
                    <UserMinus size={14} /> {t("participants.withdraw")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
          {participants.map((participant) => (
            <span key={participant.userId} className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs text-fg">
              <span className="max-w-40 truncate">{participant.username || participant.userId}</span>
              <Badge tone={participantTone(participant.status)}>{participant.status.toLowerCase()}</Badge>
              {removable(participant) && (
                <IconButton
                  className="h-5 w-5"
                  title={t("participants.withdraw")}
                  aria-label={t("participants.withdrawUser", { name: participant.username })}
                  disabled={busy}
                  onClick={() => void run(() => onWithdraw!(participant.userId))}
                >
                  <UserMinus size={12} />
                </IconButton>
              )}
            </span>
          ))}
        </div>
      )}
      {showAdd && layout === "list" && (
        <div className="mt-2 flex justify-end">
          <TaskParticipantAdd participants={participants} onAdd={onAdd!} prominent />
        </div>
      )}
    </div>
  );
}

function participantTone(status: TaskParticipantDTO["status"]) {
  return status === "COMPLETED" ? "success" : status === "ACKNOWLEDGED" ? "accent" : status === "SENT" ? "neutral" : "danger";
}

export function TaskParticipantAdd({
  participants,
  onAdd,
  prominent = false,
  fullWidth = false,
}: {
  participants: TaskParticipantDTO[];
  onAdd: (targets: ParticipantTargets) => Promise<void>;
  /** A full-size secondary "Add member" button instead of the compact ghost "Add". */
  prominent?: boolean;
  /** Stretch the (prominent) button across its container, e.g. under a row of action buttons. */
  fullWidth?: boolean;
}) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const exclude = new Set(participants.map((participant) => participant.userId));
  // Called fire-and-forget from the picker, so as with Withdraw a rejection would
  // be unhandled. The caller's mutation already toasts it; the dialog stays open
  // (it only closes on success) and, once not busy, can be submitted again.
  const add = async (targets: ParticipantTargets) => {
    setBusy(true);
    try {
      await onAdd(targets);
      setOpen(false);
    } catch {
      // Reported by the caller.
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant={prominent ? "secondary" : "ghost"}
        size="sm"
        className={prominent ? `max-w-full whitespace-normal text-center ${fullWidth ? "w-full" : ""}` : "h-7 shrink-0 px-2 text-xs"}
        onClick={() => setOpen(true)}
      >
        <Plus size={prominent ? 14 : 13} /> {t(prominent ? "participants.addMember" : "participants.add")}
      </Button>
      <Modal open={open} onClose={busy ? () => {} : () => setOpen(false)} title={t("participants.addTitle")}>
        <AddParticipantsPicker
          excludeUserIds={exclude}
          busy={busy}
          onConfirm={(targets) => void add(targets)}
          onCancel={() => setOpen(false)}
          confirmLabel={t("participants.add")}
        />
      </Modal>
    </>
  );
}
