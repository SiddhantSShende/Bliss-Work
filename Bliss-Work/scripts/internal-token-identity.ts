/*
 * Internal-service-secret identity suite.
 *
 * Proves each service that exposes an /internal/* route validates against its
 * OWN secret — not the single shared TB_INTERNAL_TOKEN this platform used to
 * rely on (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2). For each
 * service: no token is rejected, ANOTHER service's real, valid-elsewhere
 * token is rejected, and its own token is accepted (the request may still
 * fail for unrelated reasons — a 404 on a nonexistent row, say — but must not
 * be rejected as an auth failure).
 *
 * Run against a live stack (docker-compose.yml's dev tokens are distinct per
 * service specifically so this test means something — see .env.example):
 *     npx tsx scripts/internal-token-identity.ts
 *
 * WHAT THIS DOES NOT COVER: this only exercises the HTTP-facing check (does
 * the wrong token get rejected?), not blast radius — whether a compromised
 * container's own environment exposes secrets beyond the one it needs. In
 * docker-compose.prod.yml that second property was traded away when the six
 * per-service .env.prod.*-internal-token files were merged back into a
 * single .env.prod (see the dated addendum in
 * docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2) — every application service's
 * container now carries every *_INTERNAL_TOKEN regardless of whether it
 * calls that callee. This suite passing is not evidence that isolation
 * property holds; it never tested it.
 */
import { BASE } from "./_tb.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`✅ PASS  ${name}`);
  } else {
    fail++;
    console.log(`❌ FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const TOKENS = {
  auth: process.env.AUTH_INTERNAL_TOKEN ?? "dev-internal-token-auth",
  task: process.env.TASK_INTERNAL_TOKEN ?? "dev-internal-token-task",
  messaging: process.env.MESSAGING_INTERNAL_TOKEN ?? "dev-internal-token-messaging",
  wsGateway: process.env.WS_GATEWAY_INTERNAL_TOKEN ?? "dev-internal-token-ws-gateway",
  integrations: process.env.INTEGRATIONS_INTERNAL_TOKEN ?? "dev-internal-token-integrations",
};

interface Probe {
  service: string;
  ownToken: string;
  /** A token that is valid for some OTHER service — proves cross-identity is enforced. */
  foreignToken: string;
  /** Status this endpoint returns when the internal-token check itself rejects the caller. */
  rejectStatus: number;
  call: (token: string | undefined) => Promise<Response>;
}

async function req(base: string, path: string, opts: { method?: string; token?: string; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["x-internal-token"] = opts.token;
  return fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

const probes: Probe[] = [
  {
    service: "auth-svc",
    ownToken: TOKENS.auth,
    foreignToken: TOKENS.messaging,
    rejectStatus: 401,
    call: (token) => req(BASE.auth, `/internal/users/${NIL_UUID}`, { token }),
  },
  {
    service: "task-svc",
    ownToken: TOKENS.task,
    foreignToken: TOKENS.messaging,
    rejectStatus: 403,
    call: (token) =>
      req(BASE.task, `/api/v1/internal/tasks/by-title/${encodeURIComponent("no-such-task-xyz")}?org_id=${NIL_UUID}`, {
        method: "DELETE",
        token,
      }),
  },
  {
    service: "messaging-svc",
    ownToken: TOKENS.messaging,
    foreignToken: TOKENS.auth,
    rejectStatus: 401,
    call: (token) =>
      req(BASE.msg, "/internal/messages/delivered", {
        token,
        body: { recipientId: NIL_UUID, messageIds: [NIL_UUID] },
      }),
  },
  {
    service: "integrations-svc",
    ownToken: TOKENS.integrations,
    foreignToken: TOKENS.messaging,
    rejectStatus: 401,
    call: (token) =>
      req(BASE.integrations, "/internal/messages/send", {
        token,
        body: { orgId: NIL_UUID, connectionId: NIL_UUID, target: "x", text: "x" },
      }),
  },
  {
    service: "ws-gateway",
    ownToken: TOKENS.wsGateway,
    foreignToken: TOKENS.messaging,
    rejectStatus: 401,
    call: (token) => req(BASE.wsGatewayHttp, "/internal/push", { token, body: {} }),
  },
];

async function main() {
  console.log("── Internal-service-secret identity suite ──\n");

  for (const p of probes) {
    const noToken = await p.call(undefined);
    check(`${p.service}: no token → ${p.rejectStatus}`, noToken.status === p.rejectStatus, `got ${noToken.status}`);

    const foreign = await p.call(p.foreignToken);
    check(
      `${p.service}: another service's token → ${p.rejectStatus}`,
      foreign.status === p.rejectStatus,
      `got ${foreign.status}`,
    );

    const own = await p.call(p.ownToken);
    check(
      `${p.service}: its own token is NOT rejected as an auth failure`,
      own.status !== p.rejectStatus,
      `got ${own.status}`,
    );
  }

  console.log(`\n── ${fail === 0 ? "ALL PASSED 🎉" : `${fail} FAILED`} — ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(1);
});
