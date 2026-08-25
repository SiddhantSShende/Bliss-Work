import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { ApiError, type SessionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";
import { TotpEnrollPanel } from "../features/TotpEnrollPanel";
import { BackupCodesView } from "../features/BackupCodesView";
import { getPasskeyAssertion, webauthnSupported } from "../lib/webauthn";

interface ChallengeState {
  pendingToken: string;
  methods: ("totp" | "webauthn")[];
  enrollmentRequired: boolean;
}

/**
 * Reached from /login (and org-switch) when a second factor is still owed.
 * The pendingToken lives only in router state — never the URL, never
 * localStorage — since it is a bearer secret good for one MFA attempt.
 * Refreshing this page loses it by design; the caller re-enters through
 * /login.
 */
export function MfaChallenge() {
  const { api } = useRuntime();
  const nav = useNavigate();
  const qc = useQueryClient();
  const setSession = useSession((s) => s.setSession);
  const loc = useLocation();
  const state = loc.state as ChallengeState | null;

  const [pendingBackupCodes, setPendingBackupCodes] = useState<string[] | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionDTO | null>(null);

  const adopt = (session: SessionDTO) => {
    setSession({ user: session.user, accessToken: session.accessToken });
    broadcastSession(session);
    qc.clear(); // scoped to whichever org this session belongs to
    nav("/app");
  };

  if (!state?.pendingToken) {
    return (
      <AuthLayout title="Session expired" subtitle="Please sign in again.">
        <Button size="lg" className="w-full" onClick={() => nav("/login")}>
          Back to sign in
        </Button>
      </AuthLayout>
    );
  }

  // A fresh enrollment (via the restricted credential) just finished and
  // handed back backup codes + the real session — show the codes once before
  // adopting it, exactly like Settings does for an ordinary enrollment.
  if (pendingBackupCodes && pendingSession) {
    return (
      <AuthLayout title="Save your backup codes" subtitle="You're almost done.">
        <BackupCodesView codes={pendingBackupCodes} onDone={() => adopt(pendingSession)} />
      </AuthLayout>
    );
  }

  if (state.enrollmentRequired) {
    return (
      <AuthLayout
        title="Set up two-factor authentication"
        subtitle="Your workspace requires this before you can continue."
      >
        <TotpEnrollPanel
          pendingToken={state.pendingToken}
          onEnrolled={(result) => {
            if (result.session) {
              setPendingBackupCodes(result.backupCodes);
              setPendingSession(result.session);
            }
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <ChallengeForm pendingToken={state.pendingToken} methods={state.methods} onSuccess={adopt} />
  );
}

function ChallengeForm({
  pendingToken,
  methods,
  onSuccess,
}: {
  pendingToken: string;
  methods: ("totp" | "webauthn")[];
  onSuccess: (session: SessionDTO) => void;
}) {
  const { api } = useRuntime();
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const session = await api.mfaChallengeVerify(
        useBackupCode ? { pendingToken, backupCode: code } : { pendingToken, totpCode: code },
      );
      onSuccess(session);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Too many attempts", { description: "Wait a minute before trying again." });
      } else {
        toast.error(useBackupCode ? "Incorrect backup code" : "Incorrect code");
      }
    } finally {
      setBusy(false);
    }
  };

  const usePasskey = async () => {
    setPasskeyBusy(true);
    try {
      const options = await api.mfaWebauthnAuthStart(pendingToken);
      const credential = await getPasskeyAssertion(options);
      const session = await api.mfaChallengeVerify({ pendingToken, webauthnCredential: credential });
      onSuccess(session);
    } catch {
      toast.error("Couldn't verify passkey", { description: "Please try again." });
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle={useBackupCode ? "Enter one of your backup codes." : "Enter the code from your authenticator app."}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={useBackupCode ? "Backup code" : "Authentication code"}>
          <Input
            inputMode={useBackupCode ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={useBackupCode ? 32 : 10}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={useBackupCode ? "xxxxx-xxxxx" : "123456"}
            autoFocus
            required
          />
        </Field>
        <Button type="submit" loading={busy} size="lg" disabled={code.length < 4} className="w-full">
          {busy ? "Verifying…" : "Verify"}
        </Button>
        <div className="flex flex-col items-center gap-2 text-sm">
          {methods.includes("webauthn") && webauthnSupported() && (
            <button
              type="button"
              onClick={usePasskey}
              disabled={passkeyBusy}
              className="font-medium text-accent hover:underline disabled:opacity-60"
            >
              {passkeyBusy ? "Waiting for passkey…" : "Use a passkey instead"}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setUseBackupCode((v) => !v);
              setCode("");
            }}
            className="font-medium text-accent hover:underline"
          >
            {useBackupCode ? "Use an authentication code instead" : "Use a backup code instead"}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
