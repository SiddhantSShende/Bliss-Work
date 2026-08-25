import { useState } from "react";
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
import { createPasskey, webauthnSupported } from "../lib/webauthn";

/**
 * Settings > Two-factor authentication. Enrollment status is a plain
 * enrolled/not-enrolled read off the session (`user.mfaEnrolled`) — there is
 * no per-credential listing (which passkeys, TOTP-vs-not) in this pass; that
 * is a reasonable follow-up, not something this page pretends to have.
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

  const refreshUser = async () => {
    try {
      setUser(await api.me());
    } catch {
      /* cosmetic — the mutating call itself already succeeded */
    }
  };

  const addPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api.mfaWebauthnRegisterStart();
      const credential = await createPasskey(options);
      await api.mfaWebauthnRegisterFinish({ credential });
      toast.success("Passkey added");
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
        onClose={() => setStepUpAction(null)}
        onDisabled={() => void refreshUser()}
        onRegenerated={(codes) => setNewBackupCodes(codes)}
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
    const body = {
      password,
      ...(useBackupCode ? { backupCode: code } : { totpCode: code }),
    };
    try {
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
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 429 ? "Too many attempts" : "Verification failed",
        { description: "Check your password and code, then try again." },
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
