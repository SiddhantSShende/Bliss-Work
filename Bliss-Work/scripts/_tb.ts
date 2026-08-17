/* Shared helpers for seed + demo scripts (run on the host via tsx). */

export const BASE = {
  auth: process.env.TB_AUTH ?? "http://localhost:8001",
  task: process.env.TB_TASK ?? "http://localhost:8002",
  notif: process.env.TB_NOTIF ?? "http://localhost:8003",
  msg: process.env.TB_MSG ?? "http://localhost:8004",
  ws: process.env.TB_WS ?? "ws://localhost:8090/ws",
  mailpit: process.env.TB_MAILPIT ?? "http://localhost:8025",
};

// Must satisfy the hardened auth policy (min 10 chars + letter + digit + special).
export const PASSWORD = "Passw0rd!9";

export interface Session {
  accessToken: string;
  user: { id: string; orgId: string; username: string; displayName: string; email: string; roles: string[] };
}

export async function api<T>(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown; idem?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${opts.method ?? "GET"} ${path} → ${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined>,
  { tries = 30, delay = 1000 }: { tries?: number; delay?: number } = {},
): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    await sleep(delay);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Find the most recent invite token emailed to `email` (via Mailpit API). */
export async function inviteTokenFor(email: string): Promise<string> {
  return waitFor(`invite email for ${email}`, async () => {
    const list = await api<{ messages: { ID: string; To: { Address: string }[] }[] }>(
      BASE.mailpit,
      "/api/v1/messages?limit=50",
    );
    const hit = list.messages.find((m) => m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()));
    if (!hit) return null;
    const msg = await api<{ Text: string; HTML: string }>(BASE.mailpit, `/api/v1/message/${hit.ID}`);
    const body = `${msg.Text}\n${msg.HTML}`;
    const m = body.match(/token=([A-Za-z0-9_\-]+)/);
    return m ? m[1] : null;
  });
}

export async function login(email: string): Promise<Session> {
  return api<Session>(BASE.auth, "/auth/login", { body: { email, password: PASSWORD } });
}

/**
 * Ensure the org admin exists. LOGIN-FIRST so re-runs reuse the same org (the
 * `unique_slug` server logic would otherwise mint acme-2/acme-3… on each create).
 * Only creates the org when login fails (fresh DB).
 */
export async function createOrgOrLogin(
  orgName: string,
  slug: string,
  email: string,
  displayName: string,
): Promise<Session> {
  void slug;
  try {
    return await loginExisting(email);
  } catch {
    return api<Session>(BASE.auth, "/auth/orgs", {
      body: { orgName, email, password: PASSWORD, displayName },
    });
  }
}

/**
 * Ensure a member exists. LOGIN-FIRST; only runs the invite→Mailpit→accept flow
 * when the member doesn't exist yet (keeps everyone in the same org and avoids
 * picking stale invite tokens from an accumulated Mailpit inbox).
 */
export async function inviteAndAccept(
  admin: Session,
  email: string,
  username: string,
  displayName: string,
): Promise<Session> {
  try {
    return await loginExisting(email);
  } catch {
    await api(BASE.auth, "/auth/invites", { token: admin.accessToken, body: { email, role: "member" } });
    const token = await inviteTokenFor(email);
    return api<Session>(BASE.auth, "/auth/invites/accept", {
      body: { token, username, displayName, password: PASSWORD },
    });
  }
}

/**
 * Log in, treating only a 401 as "this account does not exist".
 *
 * The plain `login` above throws on any non-2xx, and its callers read a throw as
 * "not created yet" — so a rate-limited or briefly-unavailable auth-svc made a
 * script mint a SECOND invite for a member who already existed, and then fail
 * redeeming a stale token from the Mailpit backlog. Retrying the transient
 * statuses keeps that path for the case it was written for.
 */
export async function loginExisting(email: string, tries = 3): Promise<Session> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await login(email);
    } catch (e) {
      last = e;
      // 401 is a real answer: no such account, or the password differs.
      if (/→ 401/.test(String(e))) break;
      await sleep(1000 * (i + 1));
    }
  }
  throw last;
}
