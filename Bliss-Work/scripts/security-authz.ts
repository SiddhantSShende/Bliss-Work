/*
 * Cross-org authorization / IDOR test suite.
 *
 * Proves per-org isolation across the API surface — backed by app-level org
 * checks AND Postgres Row-Level Security (the DB-enforced backstop). A user in
 * org A must never read, list, or infer org B's users, tasks, or messages.
 *
 * Run against a live stack (after `npm run seed`):
 *     npx tsx scripts/security-authz.ts
 */
import { BASE, api, createOrgOrLogin, inviteAndAccept } from "./_tb.ts";

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

/** Assert an API call is REJECTED with one of `allowed` statuses (default 401/403/404). */
async function expectDenied(name: string, fn: () => Promise<unknown>, allowed = [401, 403, 404]) {
  try {
    await fn();
    check(name, false, "request SUCCEEDED but should have been denied");
  } catch (e) {
    const m = String((e as Error).message).match(/→ (\d{3})/);
    const code = m ? Number(m[1]) : 0;
    check(name, allowed.includes(code), `got status ${code} (want ${allowed.join("/")})`);
  }
}

async function main() {
  console.log("── Cross-org authorization / IDOR suite ──\n");

  // Two genuinely distinct orgs (login-first so re-runs reuse them).
  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const dave = await createOrgOrLogin("Globex", "globex", "dave@globex.com", "Dave Admin");
  check("two distinct orgs", alice.user.orgId !== dave.user.orgId,
    `A=${alice.user.orgId} B=${dave.user.orgId}`);

  // 1) IDOR on direct user lookup — neither admin may read the other's user by id.
  await expectDenied("alice cannot GET dave's user by id (IDOR)",
    () => api(BASE.auth, `/auth/users/${dave.user.id}`, { token: alice.accessToken }));
  await expectDenied("dave cannot GET alice's user by id (IDOR)",
    () => api(BASE.auth, `/auth/users/${alice.user.id}`, { token: dave.accessToken }));

  // 2) Directory isolation — neither org's directory leaks the other's members.
  const aliceDir = await api<{ id: string; username: string }[]>(BASE.auth, "/auth/directory", { token: alice.accessToken });
  const daveDir = await api<{ id: string; username: string }[]>(BASE.auth, "/auth/directory", { token: dave.accessToken });
  check("alice's directory excludes dave", !aliceDir.some((u) => u.id === dave.user.id),
    aliceDir.map((u) => u.username).join(","));
  check("dave's directory excludes alice", !daveDir.some((u) => u.id === alice.user.id),
    daveDir.map((u) => u.username).join(","));

  // 3) Unauthenticated / forged tokens are rejected.
  await expectDenied("no token → /auth/me 401", () => api(BASE.auth, "/auth/me", {}), [401]);
  await expectDenied("forged token → /auth/me 401", () => api(BASE.auth, "/auth/me", { token: "not.a.jwt" }), [401]);

  // 4) Task isolation — dave must not see a task alice created in her org.
  // A task always has a distinct sender and assignee (task-svc rejects
  // self-assignment), so this needs a second member of Acme to assign to —
  // not alice herself and not dave (a different org entirely).
  const eve = await inviteAndAccept(alice, "eve@acme.com", "eve", "Eve Member");
  const task = await api<{ taskId: string }>(BASE.task, "/api/v1/tasks", {
    token: alice.accessToken,
    body: { title: "Acme secret task", description: "org A only", assigneeIds: [eve.user.id] },
    idem: `authz-${alice.user.id}`,
  });
  const daveSent = await api<{ taskId?: string; id?: string }[]>(BASE.task, "/api/v1/tasks/sent", { token: dave.accessToken });
  const daveAssigned = await api<{ taskId?: string; id?: string }[]>(BASE.task, "/api/v1/tasks/assigned", { token: dave.accessToken });
  const seen = (list: { taskId?: string; id?: string }[]) => list.some((t) => t.taskId === task.taskId || t.id === task.taskId);
  check("dave's /tasks/sent excludes alice's task", !seen(daveSent));
  check("dave's /tasks/assigned excludes alice's task", !seen(daveAssigned));

  // 5) Messaging isolation — dave's inbox shares nothing with alice's.
  const asArray = (v: unknown): Record<string, unknown>[] => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const arr = Object.values(v as Record<string, unknown>).find(Array.isArray);
      if (arr) return arr as Record<string, unknown>[];
    }
    return [];
  };
  const key = (i: Record<string, unknown>) => (i.id ?? i.threadId ?? i.refId) as string | undefined;
  const aliceInbox = asArray(await api(BASE.msg, "/api/v1/inbox", { token: alice.accessToken }));
  const daveInbox = asArray(await api(BASE.msg, "/api/v1/inbox", { token: dave.accessToken }));
  const aliceKeys = new Set(aliceInbox.map(key));
  const overlap = daveInbox.some((i) => aliceKeys.has(key(i)));
  check("dave's inbox shares no items with alice's", !overlap,
    `aliceInbox=${aliceInbox.length} daveInbox=${daveInbox.length}`);

  console.log(`\n── ${fail === 0 ? "ALL PASSED 🎉" : `${fail} FAILED`} — ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(1);
});
