/** Password policy (mirrored server-side in auth-svc): min 8 chars + 1 special. */
export const SPECIAL_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

export interface PwCheck {
  minLen: boolean;
  special: boolean;
  ok: boolean;
}

export function checkPassword(pw: string): PwCheck {
  const minLen = pw.length >= 8;
  const special = SPECIAL_RE.test(pw);
  return { minLen, special, ok: minLen && special };
}

/** 0–4 strength score + label, for the meter (beyond the hard requirements). */
export function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (SPECIAL_RE.test(pw)) score++;
  score = Math.min(score, 4);
  const label = ["Very weak", "Weak", "Fair", "Good", "Strong"][score] ?? "Very weak";
  return { score, label };
}
