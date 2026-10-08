import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@taskboard/ui";
import { Modal } from "./Modal";

export interface LeaveStepUp {
  password: string;
  totpCode?: string;
  backupCode?: string;
}

/**
 * The password + second-factor prompt shown when the server answers a leave with
 * 403 "re-authentication required" (the identity has MFA enrolled). Same fields
 * and strings as the MFA step-up in MfaSettings; it only collects the credential
 * — LeaveOrgButton sends it and decides what a 401/429 looks like, so the modal
 * stays open for another try.
 */
export function LeaveOrgStepUpModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (stepUp: LeaveStepUp) => void;
}) {
  const { t } = useTranslation("org");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  // Whatever way it closes (cancel, or a successful leave) the credential must not linger.
  useEffect(() => {
    if (open) return;
    setPassword("");
    setCode("");
    setUseBackupCode(false);
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ password, ...(useBackupCode ? { backupCode: code } : { totpCode: code }) });
  };

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={t("org:leaveOrgButton.stepUp.title")}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-muted">{t("org:leaveOrgButton.stepUp.description")}</p>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("account:mfaSettings.stepUp.passwordPlaceholder")}
          autoComplete="current-password"
          autoFocus
          required
        />
        <Input
          inputMode={useBackupCode ? "text" : "numeric"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={
            useBackupCode
              ? t("account:mfaSettings.stepUp.backupCodePlaceholder")
              : t("account:mfaSettings.stepUp.authCodePlaceholder")
          }
          required
        />
        <button
          type="button"
          onClick={() => setUseBackupCode((v) => !v)}
          className="self-start text-xs font-medium text-accent hover:underline"
        >
          {useBackupCode
            ? t("account:mfaSettings.stepUp.useAuthCodeInstead")
            : t("account:mfaSettings.stepUp.useBackupCodeInstead")}
        </button>
        <Button type="submit" variant="danger" loading={busy} disabled={!password || code.length < 4} className="mt-1 w-full">
          {t("org:leaveOrgButton.confirmDialog.confirmLabel")}
        </Button>
      </form>
    </Modal>
  );
}
