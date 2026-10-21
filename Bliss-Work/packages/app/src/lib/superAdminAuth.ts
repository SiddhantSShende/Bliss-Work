/**
 * Super Admin session — deliberately separate from the normal multi-tenant
 * session in store/session.ts. There is no `users` row behind this
 * credential (see auth-svc/app/routes/super_admin.py), so it cannot be
 * shaped like an ordinary org session, and it must never be mixed into the
 * same store: a Super Admin token carries `roles: ["super_admin"]` only,
 * which the normal session's org-scoped UI (workspace switcher, members,
 * billing) is not written to handle.
 *
 * Kept in sessionStorage, not localStorage: this is a highly-privileged,
 * short-lived credential (see SUPER_ADMIN_SESSION_TTL_SECONDS) with no
 * refresh token to rotate it, so there is no reason for it to outlive the
 * browser tab.
 */
const STORAGE_KEY = "blisswork.super_admin_token";

export function getSuperAdminToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSuperAdminToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable (private browsing, blocked site data) — the caller
    // still has the token in memory for this page load; it just won't
    // survive a refresh. Nothing to recover from here.
  }
}

export function clearSuperAdminToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // See setSuperAdminToken.
  }
}

export class SuperAdminAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Deliberately a plain `fetch`, not the shared ApiClient: that client is
 * wired to ONE `getToken()` (the normal org session) and retries 401s by
 * refreshing it — neither applies here, and routing this through it would
 * mean teaching it about a second, unrelated credential.
 */
export async function superAdminLogin(
  authBase: string,
  email: string,
  password: string,
): Promise<{ accessToken: string; expiresIn: number; email: string }> {
  const res = await fetch(`${authBase}/auth/super-admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new SuperAdminAuthError(res.status, detail?.detail ?? "login failed");
  }
  return res.json();
}

/** Re-checks the current token against the SERVER — never trusts sessionStorage
 *  alone. Returns the Super Admin's email on success, null on any rejection
 *  (expired, revoked-by-config-change, or simply absent). */
export async function superAdminMe(authBase: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${authBase}/auth/super-admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.email ?? null;
  } catch {
    return null;
  }
}
