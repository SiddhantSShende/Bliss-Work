import { useCallback, useEffect, useState } from 'react';
import { useRuntime } from '@taskboard/app/lib/runtime';

/**
 * CAPTCHA challenge + answer for the login form. Mirrors
 * packages/app/src/features/Captcha.tsx's useCaptcha hook (same fetch/
 * refresh/loading dance, same reasoning for why refresh() must run after
 * EVERY failed attempt, not only a captcha-specific error — see LoginScreen's
 * catch block) — reimplemented rather than imported because that file's
 * OTHER export, CaptchaField, is built on DOM elements and @taskboard/ui,
 * neither portable to React Native; splitting the hook out into its own file
 * would be a refactor of shared web code for a dependency this small.
 *
 * `enabled` false fetches nothing (iOS sign-in is not challenged); flipping it
 * to true starts the fetch, which is how LoginScreen falls back to showing a
 * CAPTCHA the server turns out to want after all.
 */
export function useCaptcha(enabled = true) {
  const { api } = useRuntime();
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setValue('');
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
