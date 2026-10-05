import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { Field } from "../routes/Onboarding";

/**
 * CAPTCHA challenge + answer, shared by Login and Onboarding so neither
 * re-implements the fetch/refresh/loading dance. The server is the only
 * party that ever knows the plaintext — this hook only ever holds a
 * `captchaId` and the guess the user typed.
 *
 * A CAPTCHA is single-use: once auth-svc validates one (even if the REST of
 * the request then fails, e.g. a wrong password), that captcha_id is dead.
 * So `refresh()` must run after EVERY failed login/registration attempt, not
 * only a captcha-specific error — otherwise a retry with a corrected
 * password but the same (now-consumed) captcha_id fails again for a reason
 * the user never sees. See Login.tsx / Onboarding.tsx's catch blocks.
 *
 * `enabled` false fetches nothing: Login passes it for platforms that are not
 * challenged (macOS, iOS), so they never wait on — or request — an image they
 * will not be asked to solve. Flipping it to true starts the fetch.
 */
export function useCaptcha(enabled = true) {
  const { api } = useRuntime();
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setValue("");
    try {
      const challenge = await api.getCaptcha();
      setCaptchaId(challenge.captchaId);
      setImageUrl(challenge.captchaImage);
    } catch {
      setCaptchaId(null);
      setImageUrl(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { captchaId, imageUrl, value, setValue, loading, refresh };
}

export type CaptchaState = ReturnType<typeof useCaptcha>;

export function CaptchaField({ captcha }: { captcha: CaptchaState }) {
  const { t } = useTranslation("auth");
  return (
    <Field label={t("captcha.securityCheckLabel")}>
      <div className="flex items-center gap-2">
        <div className="flex h-[52px] w-[160px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2">
          {captcha.imageUrl ? (
            <img
              src={captcha.imageUrl}
              alt={t("captcha.imageAlt")}
              className="h-full w-full object-cover"
            />
          ) : (
            <Loader2 size={16} className="animate-spin text-muted" aria-hidden />
          )}
        </div>
        <button
          type="button"
          onClick={() => void captcha.refresh()}
          disabled={captcha.loading}
          className="shrink-0 rounded-lg p-2.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          title={t("captcha.getNewCaptcha")}
          aria-label={t("captcha.getNewCaptcha")}
        >
          <RefreshCw size={16} className={captcha.loading ? "animate-spin" : undefined} />
        </button>
      </div>
      <Input
        value={captcha.value}
        onChange={(e) => captcha.setValue(e.target.value)}
        placeholder={t("captcha.answerPlaceholder")}
        maxLength={32}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={t("captcha.answerAriaLabel")}
        required
      />
    </Field>
  );
}
