/** Password policy — mirrors the server (auth-svc/app/security/passwords.py):
 *  min 10 chars, with a letter, a digit AND a special character. The server is
 *  the source of truth; this is UX only (the meter + inline hints). */
export const SPECIAL_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;
const LETTER_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9]/;
export const MIN_PASSWORD_LENGTH = 10;

export interface PwCheck {
  minLen: boolean;
  letter: boolean;
  digit: boolean;
  special: boolean;
  ok: boolean;
}

export function checkPassword(pw: string): PwCheck {
  const minLen = pw.length >= MIN_PASSWORD_LENGTH;
  const letter = LETTER_RE.test(pw);
  const digit = DIGIT_RE.test(pw);
  const special = SPECIAL_RE.test(pw);
  return { minLen, letter, digit, special, ok: minLen && letter && digit && special };
}

export const STRENGTH_LABEL_KEYS = ["veryWeak", "weak", "fair", "good", "strong"] as const;

/** 0–4 strength score, for the meter (beyond the hard requirements). The
 *  caller resolves `STRENGTH_LABEL_KEYS[score]` through i18n — see
 *  PasswordField.tsx — rather than this pure function owning any wording. */
export function passwordStrength(pw: string): { score: number } {
  if (!pw) return { score: 0 };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (SPECIAL_RE.test(pw)) score++;
  score = Math.min(score, 4);
  return { score };
}
