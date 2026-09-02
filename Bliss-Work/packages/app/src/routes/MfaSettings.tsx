import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
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
  const { api } = useRuntime();
  const goBack = useGoBack();
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);

  const [enrolling, setEnrolling] = useState<"totp" | null>(null);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [stepUpAction, setStepUpAction] = useState<"disable" | "regenerate" | null>(null);
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
      toast.error("Couldn't refresh your account", {
        description: "Your two-factor authentication status on this page may be out of date — refresh to see the latest.",
      });
    }
  };

  const addPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api.mfaWebauthnRegisterStart();
      const credential = await createPasskey(options);
      await api.mfaWebauthnRegisterFinish({ credential });
      toast.success("Passkey added");
      setHasPasskey(true);
      await refreshUser();
    } catch {
      toast.error("Couldn't add passkey", { description: "Please try again." });
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Two-factor authentication"
        subtitle="Add a second step to signing in — an authenticator app or a passkey."
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
                  <div className="text-sm font-semibold text-fg">Two-factor authentication is on</div>
                  <div className="mt-0.5 text-xs text-muted">
                    You'll be asked for a second factor when you sign in.
                  </div>
                </div>
              </div>

              {webauthnSupported() && (
                <div className="glass flex items-center gap-4 rounded-2xl p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Fingerprint size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-fg">Add a passkey</div>
                    <div className="mt-0.5 text-xs text-muted">
                      Use your device's fingerprint, face, or a security key instead of a code.
                    </div>
                  </div>
                  <Button variant="subtle" size="sm" loading={passkeyBusy} onClick={addPasskey}>
                    Add
                  </Button>
                </div>
              )}

              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <KeyRound size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">Backup codes</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Regenerating replaces every unused code — old ones stop working immediately.
                  </div>
                </div>
                <Button variant="subtle" size="sm" onClick={() => setStepUpAction("regenerate")}>
                  Regenerate
                </Button>
              </div>

              <div className="glass flex items-center gap-4 rounded-2xl p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
                  <ShieldOff size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">Turn off two-factor authentication</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Removes your authenticator app, passkeys, and backup codes.
                  </div>
                </div>
                <Button variant="danger" size="sm" onClick={() => setStepUpAction("disable")}>
                  Turn off
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
                  <div className="text-sm font-semibold text-fg">Authenticator app</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Google Authenticator, 1Password, Authy, or any TOTP app.
                  </div>
                </div>
                <Button variant="subtle" size="sm" onClick={() => setEnrolling("totp")}>
                  Set up
                </Button>
              </div>
              {webauthnSupported() && (
                <div className="glass flex items-center gap-4 rounded-2xl p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Fingerprint size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-fg">Passkey</div>
                    <div className="mt-0.5 text-xs text-muted">
                      Your device's fingerprint, face, or a security key.
                    </div>
                  </div>
                  <Button variant="subtle" size="sm" loading={passkeyBusy} onClick={addPasskey}>
                    Set up
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal open={!!newBackupCodes} onClose={() => {}} title="Save your backup codes">
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
}: {
  action: "disable" | "regenerate" | null;
  /** Whether the caller has a registered passkey — see MfaSettings' own
   *  `hasPasskey` state for why this can't be derived locally. */
  hasPasskey: boolean;
  onClose: () => void;
  onDisabled: () => void;
  onRegenerated: (codes: string[]) => void;
}) {
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
   *  attempted (password+code vs. password+passkey). */
  const finishStepUp = async (body: {
    password: string;
    totpCode?: string;
    backupCode?: string;
    webauthnCredential?: unknown;
  }) => {
    if (action === "disable") {
      await api.mfaDisable(body);
      toast.success("Two-factor authentication turned off");
      onDisabled();
    } else if (action === "regenerate") {
      const result = await api.mfaRegenerateBackupCodes(body);
      onRegenerated(result.backupCodes);
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
        err instanceof ApiError && err.status === 429 ? "Too many attempts" : "Verification failed",
        { description: "Check your password and code, then try again." },
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
      toast.error("Couldn't verify passkey", { description: "Please try again." });
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
      title={action === "disable" ? "Confirm it's you" : "Confirm it's you to regenerate codes"}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          autoComplete="current-password"
          autoFocus
          required
        />
        <Input
          inputMode={useBackupCode ? "text" : "numeric"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={useBackupCode ? "Backup code" : "Authentication code"}
          required
        />
        <button
          type="button"
          onClick={() => setUseBackupCode((v) => !v)}
          className="self-start text-xs font-medium text-accent hover:underline"
        >
          {useBackupCode ? "Use an authentication code instead" : "Use a backup code instead"}
        </button>
        {hasPasskey && webauthnSupported() && (
          <button
            type="button"
            onClick={usePasskey}
            disabled={!password || passkeyBusy}
            className="self-start text-xs font-medium text-accent hover:underline disabled:opacity-60"
          >
            {passkeyBusy ? "Waiting for passkey…" : "Use a passkey instead"}
          </button>
        )}
        <Button
          type="submit"
          variant={action === "disable" ? "danger" : "primary"}
          loading={busy}
          disabled={!password || code.length < 4}
          className="mt-1 w-full"
        >
          {action === "disable" ? "Turn off two-factor authentication" : "Regenerate backup codes"}
        </Button>
      </form>
    </Modal>
  );
}
