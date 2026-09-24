import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { ApiError, type SessionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";
import { TotpEnrollPanel } from "../features/TotpEnrollPanel";
import { BackupCodesView } from "../features/BackupCodesView";
import { safeRedirect } from "../lib/safeRedirect";

interface ChallengeState {
  pendingToken: string;
  methods: "totp"[];
  enrollmentRequired: boolean;
  /** Where to land after verifying, e.g. a meeting link — see Login.tsx.
   *  Absent from the org-switch caller (OrgSwitcher.tsx), which always wants
   *  the default /app landing. */
  redirect?: string;
}

/**
 * Reached from /login (and org-switch) when a second factor is still owed.
 * The pendingToken lives only in router state — never the URL, never
 * localStorage — since it is a bearer secret good for one MFA attempt.
 * Refreshing this page loses it by design; the caller re-enters through
 * /login.
 */
export function MfaChallenge() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const nav = useNavigate();
  const qc = useQueryClient();
  const setSession = useSession((s) => s.setSession);
  const loc = useLocation();
  const state = loc.state as ChallengeState | null;

  const [pendingBackupCodes, setPendingBackupCodes] = useState<string[] | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionDTO | null>(null);

  const adopt = (session: SessionDTO) => {
    setSession({ user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn });
    broadcastSession(session);
    qc.clear(); // scoped to whichever org this session belongs to
    // replace: true for the same reason as Login.tsx's own post-auth nav —
    // this page must not stay in history once the session is adopted.
    nav(safeRedirect(state?.redirect), { replace: true });
  };

  if (!state?.pendingToken) {
    return (
      <AuthLayout title={t("mfaChallenge.sessionExpired.title")} subtitle={t("mfaChallenge.sessionExpired.subtitle")}>
        <Button size="lg" className="w-full" onClick={() => nav("/login")}>
          {t("mfaChallenge.sessionExpired.backToSignIn")}
        </Button>
      </AuthLayout>
    );
  }

  // A fresh enrollment (via the restricted credential) just finished and
  // handed back backup codes + the real session — show the codes once before
  // adopting it, exactly like Settings does for an ordinary enrollment.
  if (pendingBackupCodes && pendingSession) {
    return (
      <AuthLayout title={t("mfaChallenge.backupCodes.title")} subtitle={t("mfaChallenge.backupCodes.subtitle")}>
        <BackupCodesView codes={pendingBackupCodes} onDone={() => adopt(pendingSession)} />
      </AuthLayout>
    );
  }

  if (state.enrollmentRequired) {
    return (
      <AuthLayout
        title={t("mfaChallenge.enrollment.title")}
        subtitle={t("mfaChallenge.enrollment.subtitle")}
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
  methods: "totp"[];
  onSuccess: (session: SessionDTO) => void;
}) {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

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
        toast.error(t("mfaChallenge.errors.tooManyAttemptsTitle"), {
          description: t("mfaChallenge.errors.tooManyAttemptsDescription"),
        });
      } else {
        toast.error(useBackupCode ? t("mfaChallenge.errors.incorrectBackupCode") : t("mfaChallenge.errors.incorrectCode"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("mfaChallenge.challenge.title")}
      subtitle={useBackupCode ? t("mfaChallenge.challenge.backupCodeSubtitle") : t("mfaChallenge.challenge.authenticatorSubtitle")}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={useBackupCode ? t("mfaChallenge.challenge.backupCodeLabel") : t("mfaChallenge.challenge.authCodeLabel")}>
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
          {busy ? t("mfaChallenge.challenge.verifying") : t("mfaChallenge.challenge.verify")}
        </Button>
        <div className="flex flex-col items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setUseBackupCode((v) => !v);
              setCode("");
            }}
            className="font-medium text-accent hover:underline"
          >
            {useBackupCode ? t("mfaChallenge.challenge.useAuthCodeInstead") : t("mfaChallenge.challenge.useBackupCodeInstead")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
