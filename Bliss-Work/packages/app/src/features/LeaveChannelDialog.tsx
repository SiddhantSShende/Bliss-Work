import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("chatList");
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={channel ? t("leaveChannel.titleNamed", { channel: channel.name }) : t("leaveChannel.titleGeneric")}
      message={
        channel?.isLocked
          ? t("leaveChannel.messageLocked")
          : t("leaveChannel.messageOpen")
      }
      confirmLabel={t("leaveChannel.confirmLabel")}
      danger
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}
