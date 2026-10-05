import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { Modal } from "./Modal";

export function ConfirmDialog({
  open,
  onClose,
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm leading-relaxed text-muted">{message}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          {t("confirmDialog.cancel")}
        </Button>
        <Button type="button" variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
          {confirmLabel ?? t("common:confirmDialog.confirmDefault")}
        </Button>
      </div>
    </Modal>
  );
}
