/**
 * E2E for the people-centric inbox feature against the running stack.
 *   npx tsx scripts/inbox-e2e.ts
 *
 * Validates the new messaging-svc surface and the receive→act flows:
 *   - GET /api/v1/inbox            unified feed (THREAD + TASK rows)
 *   - GET /api/v1/inbox/peers      People sidebar (distinct counterparties + rollups)
 *   - GET /api/v1/inbox?peerId=    per-person filter (isolation)
 *   - message Reply target (threadId) + thread Ignore hides for BOTH
 *   - task SENT badge → Acknowledge → ACKNOWLEDGED badge; Ignore hides the row
 *
 * Exits non-zero on any failed assertion.
 */
import { BASE, createOrgOrLogin, inviteAndAccept, api, waitFor } from "./_tb";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!ok) failures++;
}

interface InboxItem {
  itemKind: "THREAD" | "TASK";
  refId: string;
  peerUserId: string | null;
  peerUsername: string | null;
  unreadCount: number;
  statusBadge: string | null;
}
interface InboxPage { items: InboxItem[]; nextCursor: string | null }
interface InboxPeer {
  peerId: string;
  username: string | null;
  displayName: string | null;
  unreadCount: number;
  itemCount: number;
}
const uuid = () => crypto.randomUUID();
const inbox = (tok: string, peerId?: string) =>
  api<InboxPage>(BASE.msg, `/api/v1/inbox?limit=100${peerId ? `&peerId=${peerId}` : ""}`, { token: tok });
const peers = (tok: string) => api<InboxPeer[]>(BASE.msg, "/api/v1/inbox/peers", { token: tok });

async function main() {
  console.log("── Inbox (compose + people-centric) E2E ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  console.log("Onboarded alice, bob, carol.\n");

  // ── 1. Message: alice → bob, threads + people sidebar ────────────────────
  console.log("1 — Message → inbox THREAD row + peers:");
  const msg = await api<{ threadId: string; conversationId: string }>(
    BASE.msg,
    "/api/v1/conversations/messages",
    { token: alice.accessToken, body: { recipientId: bob.user.id, body: "Inbox E2E ping 👋", clientMsgId: uuid() } },
  );

  const bobThread = await waitFor("bob inbox shows the THREAD", async () => {
    const p = await inbox(bob.accessToken);
    return p.items.find((it) => it.itemKind === "THREAD" && it.refId === msg.threadId) ?? null;
  });
  check("bob's /inbox has the THREAD row", !!bobThread);
  check("THREAD peerUserId is alice", bobThread.peerUserId === alice.user.id);
  check("THREAD is unread for bob", bobThread.unreadCount >= 1);

  const bobPeers1 = await waitFor("bob peers includes alice", async () => {
    const ps = await peers(bob.accessToken);
    return ps.find((p) => p.peerId === alice.user.id) ?? null;
  });
  check("/inbox/peers lists alice with unread + item rollups", bobPeers1.unreadCount >= 1 && bobPeers1.itemCount >= 1);
  check("peer displayName resolved via user_projection", bobPeers1.displayName === "Alice Admin");

  // Sender side also gets a THREAD row, peer = bob.
  const aliceThread = await waitFor("alice (sender) inbox shows the THREAD", async () => {
    const p = await inbox(alice.accessToken);
    return p.items.find((it) => it.itemKind === "THREAD" && it.refId === msg.threadId) ?? null;
  });
  check("alice's own /inbox has the THREAD (peer = bob)", aliceThread.peerUserId === bob.user.id);

  // ── 2. Task: alice → bob, SENT badge ─────────────────────────────────────
  console.log("\n2 — Task → inbox TASK row (SENT) + Acknowledge:");
  const t1 = await api<{ taskId: string }>(BASE.task, "/api/v1/tasks", {
    token: alice.accessToken,
    idem: uuid(),
    body: { title: "E2E: review the inbox PR", description: "Acknowledge me.", assigneeIds: [bob.user.id] },
  });
  const bobTask = await waitFor("bob inbox shows the TASK (SENT)", async () => {
    const p = await inbox(bob.accessToken);
    return p.items.find((it) => it.itemKind === "TASK" && it.refId === t1.taskId && it.statusBadge === "SENT") ?? null;
  });
  check("bob's /inbox has the TASK with SENT badge", !!bobTask);
  check("TASK peerUserId is the sender (alice)", bobTask.peerUserId === alice.user.id);

  // Acknowledge → badge flips to ACKNOWLEDGED in the projection.
  await api(BASE.task, `/api/v1/tasks/${t1.taskId}/assignees/me/acknowledge`, { method: "POST", token: bob.accessToken });
  const acked = await waitFor("TASK badge → ACKNOWLEDGED", async () => {
    const p = await inbox(bob.accessToken);
    const it = p.items.find((x) => x.itemKind === "TASK" && x.refId === t1.taskId);
    return it && it.statusBadge === "ACKNOWLEDGED" ? it : null;
  });
  check("Acknowledge updated the inbox TASK badge to ACKNOWLEDGED", !!acked);

  // ── 3. Task Ignore hides the row ─────────────────────────────────────────
  console.log("\n3 — Task Ignore removes it from the inbox:");
  const t2 = await api<{ taskId: string }>(BASE.task, "/api/v1/tasks", {
    token: alice.accessToken,
    idem: uuid(),
    body: { title: "E2E: ignore me", description: "", assigneeIds: [bob.user.id] },
  });
  await waitFor("t2 visible before ignore", async () => {
    const p = await inbox(bob.accessToken);
    return p.items.find((it) => it.refId === t2.taskId) ?? null;
  });
  await api(BASE.task, `/api/v1/tasks/${t2.taskId}/assignees/me/ignore`, { method: "POST", token: bob.accessToken });
  const t2Gone = await waitFor("t2 hidden after ignore", async () => {
    const p = await inbox(bob.accessToken);
    return p.items.every((it) => it.refId !== t2.taskId) ? true : null;
  });
  check("Ignored task disappeared from bob's /inbox", t2Gone);

  // ── 4. Per-person filter isolation (carol → bob) ─────────────────────────
  console.log("\n4 — peerId filter isolates one person's items:");
  const cmsg = await api<{ threadId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token: carol.accessToken,
    body: { recipientId: bob.user.id, body: "carol here", clientMsgId: uuid() },
  });
  await waitFor("carol thread visible in bob's all-feed", async () => {
    const p = await inbox(bob.accessToken);
    return p.items.find((it) => it.refId === cmsg.threadId) ?? null;
  });
  const byAlice = await inbox(bob.accessToken, alice.user.id);
  const byCarol = await inbox(bob.accessToken, carol.user.id);
  check("peerId=alice returns only alice's items", byAlice.items.every((it) => it.peerUserId === alice.user.id) && byAlice.items.length > 0);
  check("peerId=alice excludes carol's thread", byAlice.items.every((it) => it.refId !== cmsg.threadId));
  check("peerId=carol returns carol's thread", byCarol.items.some((it) => it.refId === cmsg.threadId));

  // ── 5. Thread Ignore hides for BOTH parties ──────────────────────────────
  console.log("\n5 — Thread Ignore hides for both sender + receiver:");
  await api(BASE.msg, `/api/v1/threads/${msg.threadId}/ignore`, { method: "POST", token: bob.accessToken, idem: uuid() });
  const threadGoneBoth = await waitFor("alice↔bob thread gone from BOTH inboxes", async () => {
    const [bp, ap] = await Promise.all([inbox(bob.accessToken), inbox(alice.accessToken)]);
    const inBob = bp.items.some((it) => it.refId === msg.threadId);
    const inAlice = ap.items.some((it) => it.refId === msg.threadId);
    return !inBob && !inAlice ? true : null;
  });
  check("Thread Ignore removed it from both alice and bob", threadGoneBoth);

  console.log(`\n── ${failures === 0 ? "ALL PASSED 🎉" : `${failures} FAILED`} ──`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("inbox-e2e crashed:", e);
  process.exit(1);
});
