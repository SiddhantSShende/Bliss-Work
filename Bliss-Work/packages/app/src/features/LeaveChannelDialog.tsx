import type { ChannelDTO } from "@taskboard/shared";
import { ConfirmDialog } from "./ConfirmDialog";

/** The confirm dialog every "Leave channel" action shows — same title,
 *  locked-vs-open message, and label whether triggered from inside the
 *  channel (ChannelView) or from its row in the list (ChannelsList). */
export function LeaveChannelDialog({
  channel,
  open,
  onClose,
  busy,
  onConfirm,
}: {
  channel: ChannelDTO | null | undefined;
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={channel ? `Leave #${channel.name}?` : "Leave channel?"}
      message={
        channel?.isLocked
          ? "This is a locked channel. A member will need to re-invite you to come back."
          : "You can re-join from the Browse tab whenever you want."
      }
      confirmLabel="Leave channel"
      danger
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}
