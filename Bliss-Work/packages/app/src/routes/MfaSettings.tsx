import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
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
import { createPasskey, getPasskeyAssertion, webauthnSupported } from "../lib/webauthn";

/**
 * Settings > Two-factor authentication. Enrollment status is a plain
 * enrolled/not-enrolled read off the session (`user.mfaEnrolled`) — there is
 * still no full per-credential listing (nicknames, added-on dates, per-key
 * removal) in this pass; that remains a reasonable follow-up. The one piece
 * of per-method state this page DOES fetch is whether a passkey is
 * registered at all (`hasPasskey`, via `api.mfaMethods()`) — needed so the
 * step-up modal (disable / regenerate backup codes) can offer a passkey to a
 * passkey-only enrollee, who has no TOTP code or backup code to type there
 * instead.
 */
export function MfaSettings() {
  const { t } = useTranslation("account");
  const { api } = useRuntime();
  const goBack = useGoBack();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  const [enrolling, setEnrolling] = useState<"totp" | null>(null);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [stepUpAction, setStepUpAction] = useState<"disable" | "regenerate" | "addPasskey" | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // Whether the user has a registered passkey — gates the step-up modal's
  // "use a passkey instead" option (see StepUpModal). Not derivable from
  // `user.mfaEnrolled` alone: a passkey-only enrollee has no TOTP secret and
  // no minted backup codes, so without this the step-up modal would offer
  // them only fields they can never fill in.
  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    if (!user?.mfaEnrolled) return;
    let alive = true;
    api
      .mfaMethods()
      .then((r) => alive && setHasPasskey(r.methods.includes("webauthn")))
      // Best-effort: this only gates an optional step-up shortcut — password
      // + code/backup-code stays available in the modal either way.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, user?.mfaEnrolled]);

  // Backup codes are shown exactly once and never again — losing this modal
  // (tab close, refresh) before the "I've saved these" acknowledgement is an
  // account-recovery dead end. The modal already blocks Escape/backdrop
  // click; this covers the paths those can't: browser refresh and tab close.
  // `newBackupCodes` becomes null only via BackupCodesView's onDone, which is
  // gated on that same acknowledgement, so this effect's own lifetime is
  // already exactly "codes showing and not yet acknowledged" — no separate
  // ack flag needs to be threaded up from BackupCodesView.
  //
  // This does NOT cover the in-app back button: this app renders inside a
  // plain <BrowserRouter> (see App.tsx), not a data router, and
  // react-router's history-blocking APIs (useBlocker) only work under one.
  useEffect(() => {
    if (!newBackupCodes) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [newBackupCodes]);

  const refreshUser = async () => {
    try {
      setUser(await api.me());
      return;
    } catch {
      /* transient network blip — worth one retry before bothering the user */
    }
    try {
      setUser(await api.me());
    } catch {
      // The mutating call itself already succeeded, but this page's branch
      // (which of the three MFA sections renders) is keyed off
      // `user.mfaEnrolled` — a stale value here can keep showing "MFA is on"
      // with working controls right after MFA was actually turned off.
      toast.error(t("account:mfaSettings.toasts.refreshFailed.title"), {
        description: t("account:mfaSettings.toasts.refreshFailed.description"),
      });
    }
  };

  const addPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api.mfaWebauthnRegisterStart();
      const credential = await createPasskey(options);
      await api.mfaWebauthnRegisterFinish({ credential });
      toast.success(t("account:mfaSettings.toasts.passkeyAdded"));
      setHasPasskey(true);
      await refreshUser();
    } catch {
      toast.error(t("account:mfaSettings.toasts.addPasskeyFailed.title"), {
        description: t("account:mfaSettings.toasts.addPasskeyFailed.description"),
      });
    } finally {
      setPasskeyBusy(false);
    }
  };

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
                  <div className="mt-0.5 text-xs text-muted">
                    {t("account:mfaSettings.enrolled.status.description")}
                  </div>
                </div>
              </div>

              {webauthnSupported() && (
                <div className="glass flex items-center gap-4 rounded-2xl p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Fingerprint size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.enrolled.addPasskey.title")}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {t("account:mfaSettings.enrolled.addPasskey.description")}
                    </div>
                  </div>
                  <Button variant="subtle" size="sm" onClick={() => setStepUpAction("addPasskey")}>
                    {t("account:mfaSettings.enrolled.addPasskey.action")}
                  </Button>
                </div>
              )}

              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <KeyRound size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.enrolled.backupCodes.title")}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {t("account:mfaSettings.enrolled.backupCodes.description")}
                  </div>
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
                  <div className="mt-0.5 text-xs text-muted">
                    {t("account:mfaSettings.enrolled.disable.description")}
                  </div>
                </div>
                <Button variant="danger" size="sm" onClick={() => setStepUpAction("disable")}>
                  {t("account:mfaSettings.enrolled.disable.action")}
                </Button>
              </div>
            </>
          ) : enrolling === "totp" ? (
            <div className="glass rounded-2xl p-5">
              <TotpEnrollPanel
                onEnrolled={(result) => {
                  setEnrolling(null);
                  setNewBackupCodes(result.backupCodes);
                }}
              />
            </div>
          ) : (
            <>
              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <ShieldCheck size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.notEnrolled.totp.title")}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {t("account:mfaSettings.notEnrolled.totp.description")}
                  </div>
                </div>
                <Button variant="subtle" size="sm" onClick={() => setEnrolling("totp")}>
                  {t("account:mfaSettings.notEnrolled.setUp")}
                </Button>
              </div>
              {webauthnSupported() && (
                <div className="glass flex items-center gap-4 rounded-2xl p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Fingerprint size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-fg">{t("account:mfaSettings.notEnrolled.passkey.title")}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {t("account:mfaSettings.notEnrolled.passkey.description")}
                    </div>
                  </div>
                  <Button variant="subtle" size="sm" loading={passkeyBusy} onClick={addPasskey}>
                    {t("account:mfaSettings.notEnrolled.setUp")}
                  </Button>
                </div>
              )}
            </>
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
        hasPasskey={hasPasskey}
        onClose={() => setStepUpAction(null)}
        onDisabled={() => void refreshUser()}
        onRegenerated={(codes) => setNewBackupCodes(codes)}
        onPasskeyAdded={() => {
          setHasPasskey(true);
          void refreshUser();
        }}
      />
    </div>
  );
}

function StepUpModal({
  action,
  hasPasskey,
  onClose,
  onDisabled,
  onRegenerated,
  onPasskeyAdded,
}: {
  action: "disable" | "regenerate" | "addPasskey" | null;
  /** Whether the caller has a registered passkey — see MfaSettings' own
   *  `hasPasskey` state for why this can't be derived locally. */
  hasPasskey: boolean;
  onClose: () => void;
  onDisabled: () => void;
  onRegenerated: (codes: string[]) => void;
  onPasskeyAdded: () => void;
}) {
  const { t } = useTranslation("account");
  const { api } = useRuntime();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const reset = () => {
    setPassword("");
    setCode("");
    setUseBackupCode(false);
  };

  /** Shared by both step-up paths (code/backup-code form submit, and the
   *  passkey button below): dispatch to whichever action this modal is open
   *  for, then close it. Left to throw — each caller wraps this in its own
   *  try/catch so the error toast can say something specific to what it just
   *  attempted (password+code vs. password+passkey).
   *
   *  `addPasskey` is the odd one out: `body` here only PROVES who's asking —
   *  it still has to be forwarded as `stepUp` on a completely separate
   *  WebAuthn REGISTRATION ceremony (a second, different browser prompt when
   *  the step-up itself was done via an existing passkey) to actually add
   *  the new credential, mirroring what the unauthenticated `addPasskey()`
   *  above does for a first-time enrollee minus the step-up wrapper. */
  const finishStepUp = async (body: {
    password: string;
    totpCode?: string;
    backupCode?: string;
    webauthnCredential?: unknown;
  }) => {
    if (action === "disable") {
      await api.mfaDisable(body);
      toast.success(t("account:mfaSettings.toasts.mfaTurnedOff"));
      onDisabled();
    } else if (action === "regenerate") {
      const result = await api.mfaRegenerateBackupCodes(body);
      onRegenerated(result.backupCodes);
    } else if (action === "addPasskey") {
      const options = await api.mfaWebauthnRegisterStart();
      const credential = await createPasskey(options);
      await api.mfaWebauthnRegisterFinish({ credential, stepUp: body });
      toast.success(t("account:mfaSettings.toasts.passkeyAdded"));
      onPasskeyAdded();
    }
    reset();
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await finishStepUp({ password, ...(useBackupCode ? { backupCode: code } : { totpCode: code }) });
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

  // Covers the passkey-only enrollee: no TOTP secret, no minted backup
  // codes, so the form above has nothing they can actually fill in. Mirrors
  // MfaChallenge.tsx's login-time `usePasskey` — same ceremony, scoped here
  // to a step-up challenge for the already-authenticated caller instead of a
  // pending login.
  const usePasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api.mfaWebauthnStepUpStart();
      const credential = await getPasskeyAssertion(options);
      await finishStepUp({ password, webauthnCredential: credential });
    } catch {
      toast.error(t("account:mfaSettings.stepUp.toasts.passkeyVerifyFailed.title"), {
        description: t("account:mfaSettings.stepUp.toasts.passkeyVerifyFailed.description"),
      });
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <Modal
      open={action !== null}
      onClose={() => {
        reset();
        onClose();
      }}
      title={
        action === "disable"
          ? t("account:mfaSettings.stepUp.titles.disable")
          : action === "regenerate"
            ? t("account:mfaSettings.stepUp.titles.regenerate")
            : t("account:mfaSettings.stepUp.titles.addPasskey")
      }
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
        {hasPasskey && webauthnSupported() && (
          <button
            type="button"
            onClick={usePasskey}
            disabled={!password || passkeyBusy}
            className="self-start text-xs font-medium text-accent hover:underline disabled:opacity-60"
          >
            {passkeyBusy
              ? t("account:mfaSettings.stepUp.waitingForPasskey")
              : t("account:mfaSettings.stepUp.usePasskeyInstead")}
          </button>
        )}
        <Button
          type="submit"
          variant={action === "disable" ? "danger" : "primary"}
          loading={busy}
          disabled={!password || code.length < 4}
          className="mt-1 w-full"
        >
          {action === "disable"
            ? t("account:mfaSettings.enrolled.disable.title")
            : action === "regenerate"
              ? t("account:mfaSettings.stepUp.submitLabels.regenerate")
              : t("account:mfaSettings.stepUp.submitLabels.addPasskey")}
        </Button>
      </form>
    </Modal>
  );
}
