import { useState } from "react";
import { Plus, UserMinus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, IconButton } from "@taskboard/ui";
import type { TaskParticipantDTO } from "@taskboard/shared";
import { Modal } from "./Modal";
import { MemberPicker } from "./MemberPicker";

export function TaskParticipants({
  participants,
  currentUserId,
  allocatorId,
  onAdd,
  onWithdraw,
  addPlacement = "participants",
}: {
  participants: TaskParticipantDTO[];
  currentUserId: string;
  allocatorId: string;
  onAdd?: (userIds: string[]) => Promise<void>;
  onWithdraw?: (userId: string) => Promise<void>;
  addPlacement?: "name" | "participants";
}) {
  const { t } = useTranslation("tasks");
  const [busy, setBusy] = useState(false);
  const active = participants.some(
    (participant) => participant.userId === currentUserId && (participant.status === "SENT" || participant.status === "ACKNOWLEDGED"),
  );
  const hasOpenAssignment = participants.some(
    (participant) => participant.status === "SENT" || participant.status === "ACKNOWLEDGED",
  );
  const canAdd = !!onAdd && hasOpenAssignment && (currentUserId === allocatorId || active);
  const canWithdraw = currentUserId === allocatorId && !!onWithdraw;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 min-w-0 border-t border-border/50 pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{t("participants.label")}</span>
        {canAdd && addPlacement === "participants" && <TaskParticipantAdd participants={participants} onAdd={onAdd!} />}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
        {participants.map((participant) => {
          const removable = canWithdraw && participant.userId !== currentUserId && (participant.status === "SENT" || participant.status === "ACKNOWLEDGED");
          return (
            <span key={participant.userId} className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs text-fg">
              <span className="max-w-40 truncate">{participant.username || participant.userId}</span>
              <Badge tone={participant.status === "COMPLETED" ? "success" : participant.status === "ACKNOWLEDGED" ? "accent" : participant.status === "SENT" ? "neutral" : "danger"}>
                {participant.status.toLowerCase()}
              </Badge>
              {removable && (
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
          );
        })}
      </div>
    </div>
  );
}

export function TaskParticipantAdd({
  participants,
  onAdd,
}: {
  participants: TaskParticipantDTO[];
  onAdd: (userIds: string[]) => Promise<void>;
}) {
  const { t } = useTranslation("tasks");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const exclude = new Set(participants.map((participant) => participant.userId));
  const add = async (userIds: string[]) => {
    setBusy(true);
    try {
      await onAdd(userIds);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setOpen(true)}>
        <Plus size={13} /> {t("participants.add")}
      </Button>
      <Modal open={open} onClose={busy ? () => {} : () => setOpen(false)} title={t("participants.addTitle")}>
        <MemberPicker exclude={exclude} busy={busy} onConfirm={(ids) => void add(ids)} onCancel={() => setOpen(false)} confirmLabel={t("participants.add")} />
      </Modal>
    </>
  );
}
