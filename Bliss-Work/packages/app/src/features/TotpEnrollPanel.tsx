import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { ApiError, type MfaTotpEnrollConfirmResult } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";

/**
 * Enroll a TOTP authenticator app: generate a secret, show it as a QR code +
 * plain text (some apps only support one of the two), collect the 6-digit
 * code the app produces, and confirm.
 *
 * The secret rides through THIS component's own state, never persisted
 * anywhere client-side — it is sent back to the server exactly once, in the
 * confirm call, mirroring the server's own "don't persist until confirmed"
 * design (see mfa_totp.py).
 *
 * Used both from Settings (an ordinary signed-in caller) and from the
 * login-time restricted-enrollment-credential flow (`pendingToken` set) — the
 * two differ only in which credential the enroll-start/confirm calls carry.
 */
export function TotpEnrollPanel({
  pendingToken,
  onEnrolled,
}: {
  pendingToken?: string;
  onEnrolled: (result: MfaTotpEnrollConfirmResult) => void;
}) {
  const { api } = useRuntime();
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Set when the enroll-start call itself fails (as opposed to `failed`, which
  // tracks a rejected confirm code). Without this the component has no way to
  // recover from a transient network blip: secret/otpauthUrl stay null forever
  // and the render below is stuck on "Preparing enrollment…" with no retry.
  const [startError, setStartError] = useState(false);
  // Bumped by the retry button to re-run the effect below with a fresh attempt.
  const [startAttempt, setStartAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setStartError(false);
    api
      .mfaTotpEnrollStart(pendingToken)
      .then((r) => {
        if (!alive) return;
        setSecret(r.secret);
        setOtpauthUrl(r.otpauthUrl);
        return QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 220 });
      })
      .then((dataUrl) => alive && dataUrl && setQrDataUrl(dataUrl))
      .catch(() => {
        if (!alive) return;
        setStartError(true);
        toast.error("Couldn't start enrollment", { description: "Please try again." });
      });
    return () => {
      alive = false;
    };
    // pendingToken is fixed for the lifetime of one enrollment attempt;
    // startAttempt exists only so the retry button below can re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, startAttempt]);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await api.mfaTotpEnrollConfirm({ secret, code, pendingToken });
      onEnrolled(result);
    } catch (err) {
      setFailed(true);
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Too many attempts", { description: "Wait a minute before trying again." });
      } else {
        toast.error("Incorrect code", { description: "Check the time on your device and try again." });
      }
    } finally {
      setBusy(false);
    }
  };

  if (startError) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-muted">Couldn't start enrollment.</p>
        <Button variant="secondary" size="sm" onClick={() => setStartAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!secret || !otpauthUrl) {
    return <p className="py-6 text-center text-sm text-muted">Preparing enrollment…</p>;
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Scan this with an authenticator app (Google Authenticator, 1Password, Authy, …), or enter the
        setup key manually.
      </p>
      {qrDataUrl && (
        <img
          src={qrDataUrl}
          alt="Scan with your authenticator app"
          width={220}
          height={220}
          className="mx-auto rounded-xl border border-border"
        />
      )}
      <div className="rounded-lg bg-surface-2 p-3 text-center">
        <div className="text-[11px] uppercase tracking-wide text-muted">Setup key</div>
        <code className="select-all break-all text-sm font-medium text-fg">{secret}</code>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg" htmlFor="totp-code">
          Enter the 6-digit code
        </label>
        <Input
          id="totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={10}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
          aria-invalid={failed}
          autoFocus
          required
        />
      </div>
      <Button type="submit" loading={busy} size="lg" disabled={code.length < 6} className="w-full">
        {busy ? "Verifying…" : "Confirm and enable"}
      </Button>
    </form>
  );
}
