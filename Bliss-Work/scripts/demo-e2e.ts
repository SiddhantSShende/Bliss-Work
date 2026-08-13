/**
 * End-to-end demo / smoke test of BOTH features against the running stack.
 *   npm run demo   (after `make up`)
 *
 * Communication: bob → carol message, carol IGNORES → conversation must vanish
 *                from BOTH inboxes.
 * Task:          alice → bob task, bob ACKNOWLEDGES (alice notified), bob
 *                COMPLETES (alice notified).
 * Exits non-zero on any failed assertion.
 */
import { BASE, createOrgOrLogin, inviteAndAccept, api, waitFor } from "./_tb";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!ok) failures++;
}

interface Conv { id: string; peerId: string }
interface Notif { kind: string; text: string; taskId: string | null }

async function main() {
  console.log("── Task-Board E2E demo ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  console.log("Onboarded alice (admin), bob, carol.\n");

  // ── Feature 1: messaging + mutual ignore ──────────────────────────────────
  console.log("Feature 1 — Communication (reply / ignore):");
  const sent = await api<{ conversationId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token: bob.accessToken,
    body: { recipientId: carol.user.id, body: "Hi Carol, got a sec?", clientMsgId: crypto.randomUUID() },
  });
  const convId = sent.conversationId;

  await waitFor("bob sees conversation", async () => {
    const list = await api<Conv[]>(BASE.msg, "/api/v1/conversations", { token: bob.accessToken });
    return list.some((c) => c.id === convId) || null;
  });
  check("bob's inbox shows the new conversation", true);

  const carolConv = await waitFor("carol sees conversation", async () => {
    const list = await api<Conv[]>(BASE.msg, "/api/v1/conversations", { token: carol.accessToken });
    return list.find((c) => c.id === convId) ?? null;
  });
  check("carol's inbox shows the new conversation", !!carolConv);

  // carol IGNOREs → must disappear from BOTH
  await api(BASE.msg, `/api/v1/conversations/${convId}/ignore`, {
    method: "POST",
    token: carol.accessToken,
  });

  const goneBoth = await waitFor("conversation removed from both inboxes", async () => {
    const [bl, cl] = await Promise.all([
      api<Conv[]>(BASE.msg, "/api/v1/conversations", { token: bob.accessToken }),
      api<Conv[]>(BASE.msg, "/api/v1/conversations", { token: carol.accessToken }),
    ]);
    const inBob = bl.some((c) => c.id === convId);
    const inCarol = cl.some((c) => c.id === convId);
    return !inBob && !inCarol ? true : null;
  });
  check("IGNORE removed the conversation from BOTH bob and carol", goneBoth);

  // ── Feature 2: task assign → acknowledge → complete ───────────────────────
  console.log("\nFeature 2 — Task (acknowledge / complete + notifications):");
  const task = await api<{ taskId: string }>(BASE.task, "/api/v1/tasks", {
    token: alice.accessToken,
    idem: crypto.randomUUID(),
    body: { title: "Ship the demo", description: "Wire it end to end.", assigneeIds: [bob.user.id] },
  });
  check("alice created a task assigned to bob", !!task.taskId);

  await api(BASE.task, `/api/v1/tasks/${task.taskId}/assignees/me/acknowledge`, {
    method: "POST",
    token: bob.accessToken,
  });
  const ackNotif = await waitFor("alice notified of acknowledgement", async () => {
    const ns = await api<Notif[]>(BASE.notif, "/api/v1/notifications", { token: alice.accessToken });
    return ns.find((n) => n.kind === "TASK_ACKNOWLEDGED" && n.taskId === task.taskId) ?? null;
  });
  check(`alice notified: "${ackNotif.text}"`, !!ackNotif);

  await api(BASE.task, `/api/v1/tasks/${task.taskId}/assignees/me/complete`, {
    method: "POST",
    token: bob.accessToken,
  });
  const doneNotif = await waitFor("alice notified of completion", async () => {
    const ns = await api<Notif[]>(BASE.notif, "/api/v1/notifications", { token: alice.accessToken });
    return ns.find((n) => n.kind === "TASK_COMPLETED" && n.taskId === task.taskId) ?? null;
  });
  check(`alice notified: "${doneNotif.text}"`, !!doneNotif);

  console.log(`\n── ${failures === 0 ? "ALL PASSED 🎉" : `${failures} FAILED`} ──`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("demo crashed:", e);
  process.exit(1);
});
