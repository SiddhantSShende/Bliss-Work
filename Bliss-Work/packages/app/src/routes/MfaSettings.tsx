import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button, Input, PageHeader } from "@taskboard/ui";
import { ApiError } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useGoBack } from "../lib/useGoBack";
import { Modal } from "../features/Modal";
import { TotpEnrollPanel } from "../features/TotpEnrollPanel";
import { BackupCodesView } from "../features/BackupCodesView";

export function MfaSettings() {
  const { t } = useTranslation("account");
  const { api } = useRuntime();
  const goBack = useGoBack();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [enrolling, setEnrolling] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [stepUpAction, setStepUpAction] = useState<"disable" | "regenerate" | null>(null);

  const refreshUser = async () => {
    try {
      setUser(await api.me());
      return;
    } catch {
      /* transient network blip — retry once before showing an error */
    }
    try {
      setUser(await api.me());
    } catch {
      toast.error(t("account:mfaSettings.toasts.refreshFailed.title"), {
        description: t("account:mfaSettings.toasts.refreshFailed.description"),
      });
    }
  };

  useEffect(() => {
    if (!newBackupCodes) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [newBackupCodes]);

  if (!user) return null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("account:mfaSettings.header.title")}
        subtitle={t("account:mfaSettings.header.subtitle")}
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-4">
          {user.mfaEnrolled ? (
            <>
              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success">
                  <ShieldCheck size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.enrolled.status.title")}</div>
                  <div className="mt-0.5 text-xs text-muted">{t("account:mfaSettings.enrolled.status.description")}</div>
                </div>
              </div>
              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <KeyRound size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.enrolled.backupCodes.title")}</div>
                  <div className="mt-0.5 text-xs text-muted">{t("account:mfaSettings.enrolled.backupCodes.description")}</div>
                </div>
                <Button variant="subtle" size="sm" onClick={() => setStepUpAction("regenerate")}>
                  {t("account:mfaSettings.enrolled.backupCodes.action")}
                </Button>
              </div>
              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
                  <ShieldOff size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.enrolled.disable.title")}</div>
                  <div className="mt-0.5 text-xs text-muted">{t("account:mfaSettings.enrolled.disable.description")}</div>
                </div>
                <Button variant="danger" size="sm" onClick={() => setStepUpAction("disable")}>
                  {t("account:mfaSettings.enrolled.disable.action")}
                </Button>
              </div>
            </>
          ) : enrolling ? (
            <div className="glass rounded-2xl p-5">
              <TotpEnrollPanel
                onEnrolled={(result) => {
                  setEnrolling(false);
                  setNewBackupCodes(result.backupCodes);
                }}
              />
            </div>
          ) : (
            <div className="glass flex items-center gap-4 rounded-2xl p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                <ShieldCheck size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.notEnrolled.totp.title")}</div>
                <div className="mt-0.5 text-xs text-muted">{t("account:mfaSettings.notEnrolled.totp.description")}</div>
              </div>
              <Button variant="subtle" size="sm" onClick={() => setEnrolling(true)}>
                {t("account:mfaSettings.notEnrolled.setUp")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Modal open={!!newBackupCodes} onClose={() => {}} title={t("account:mfaSettings.backupCodesModal.title")}>
        {newBackupCodes && (
          <BackupCodesView
            codes={newBackupCodes}
            onDone={() => {
              setNewBackupCodes(null);
              void refreshUser();
            }}
          />
        )}
      </Modal>
      <StepUpModal
        action={stepUpAction}
        onClose={() => setStepUpAction(null)}
        onDisabled={() => void refreshUser()}
        onRegenerated={setNewBackupCodes}
      />
    </div>
  );
}

function StepUpModal({
  action,
  onClose,
  onDisabled,
  onRegenerated,
}: {
  action: "disable" | "regenerate" | null;
  onClose: () => void;
  onDisabled: () => void;
  onRegenerated: (codes: string[]) => void;
}) {
  const { t } = useTranslation("account");
  const { api } = useRuntime();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPassword("");
    setCode("");
    setUseBackupCode(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { password, ...(useBackupCode ? { backupCode: code } : { totpCode: code }) };
      if (action === "disable") {
        await api.mfaDisable(body);
        toast.success(t("account:mfaSettings.toasts.mfaTurnedOff"));
        onDisabled();
      } else if (action === "regenerate") {
        const result = await api.mfaRegenerateBackupCodes(body);
        onRegenerated(result.backupCodes);
      }
      reset();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 429
          ? t("account:mfaSettings.stepUp.toasts.tooManyAttemptsTitle")
          : t("account:mfaSettings.stepUp.toasts.verificationFailedTitle"),
        { description: t("account:mfaSettings.stepUp.toasts.verificationFailedDescription") },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={action !== null}
      onClose={() => {
        reset();
        onClose();
      }}
      title={action === "disable" ? t("account:mfaSettings.stepUp.titles.disable") : t("account:mfaSettings.stepUp.titles.regenerate")}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
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
          placeholder={useBackupCode ? t("account:mfaSettings.stepUp.backupCodePlaceholder") : t("account:mfaSettings.stepUp.authCodePlaceholder")}
          required
        />
        <button type="button" onClick={() => setUseBackupCode((v) => !v)} className="self-start text-xs font-medium text-accent hover:underline">
          {useBackupCode ? t("account:mfaSettings.stepUp.useAuthCodeInstead") : t("account:mfaSettings.stepUp.useBackupCodeInstead")}
        </button>
        <Button
          type="submit"
          variant={action === "disable" ? "danger" : "primary"}
          loading={busy}
          disabled={!password || code.length < 4}
          className="mt-1 w-full"
        >
          {action === "disable" ? t("account:mfaSettings.enrolled.disable.title") : t("account:mfaSettings.stepUp.submitLabels.regenerate")}
        </Button>
      </form>
    </Modal>
  );
}
