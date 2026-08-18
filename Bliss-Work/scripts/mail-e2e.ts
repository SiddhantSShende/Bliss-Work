/**
 * E2E for the Inbox mail module against the running stack.
 *   npx tsx scripts/mail-e2e.ts
 *
 * Covers what the unit tests cannot, because it needs a real database and a
 * real migration run:
 *   - POST /api/v1/mail/drafts           draft opens (the attachment anchor)
 *   - POST /api/v1/mail/drafts/{id}/send validation + in-app delivery fan-out
 *   - GET  /api/v1/inbox?kinds=MAIL      the mail lands in the recipient's feed
 *   - GET  /api/v1/mail/{id}             complete content, both sides
 *   - Bcc  is visible to the author and to the Bcc'd person — and to NOBODY else
 *   - POST /api/v1/mail/{id}/read        clears the unread badge
 *   - ignore is ONE-SIDED: the sender's Sent copy survives the recipient's delete
 *   - DELETE /api/v1/mail/drafts/{id}    discards an abandoned compose
 *
 * Exits non-zero on any failed assertion.
 */
import { BASE, createOrgOrLogin, inviteAndAccept, api, waitFor } from "./_tb";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!ok) failures++;
}

const uuid = () => crypto.randomUUID();

interface InboxItem {
  itemKind: "THREAD" | "TASK" | "MAIL";
  refId: string;
  peerUserId: string | null;
  preview: string;
  unreadCount: number;
  statusBadge: string | null;
}
interface InboxPage { items: InboxItem[]; nextCursor: string | null }
interface MailRecipient { kind: "TO" | "CC" | "BCC"; address: string; userId: string | null }
interface Mail {
  mailId: string;
  status: string;
  folder: "INBOX" | "SENT";
  fromAddress: string;
  subject: string;
  bodyText: string;
  recipients: MailRecipient[];
  readAt: string | null;
}

/**
 * Asserts a request FAILS with a particular status.
 *
 * `api` throws `... → <status> <body>` on any non-2xx, so the status is matched
 * out of the message rather than by a second code path — using the same helper
 * for the success and failure cases is what keeps this script testing the real
 * client behaviour instead of a parallel one.
 */
async function rejectsWith(status: number, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (e) {
    return String(e).includes(`\u2192 ${status}`);
  }
}

const mailbox = (tok: string) =>
  api<InboxPage>(BASE.msg, "/api/v1/inbox?limit=100&kinds=MAIL", { token: tok });
const getMail = (tok: string, id: string) =>
  api<Mail>(BASE.msg, `/api/v1/mail/${id}`, { token: tok });

async function compose(
  tok: string,
  mail: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyText: string },
) {
  const draft = await api<{ mailId: string }>(BASE.msg, "/api/v1/mail/drafts", {
    method: "POST",
    token: tok,
  });
  const sent = await api<{ mailId: string; deliveredInApp: number; queuedExternal: number }>(
    BASE.msg,
    `/api/v1/mail/drafts/${draft.mailId}/send`,
    { method: "POST", token: tok, idem: uuid(), body: { cc: [], bcc: [], ...mail } },
  );
  return sent;
}

async function main() {
  console.log("── Inbox mail E2E ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  console.log("Onboarded alice, bob, carol.\n");

  // ── 1. Compose → deliver ─────────────────────────────────────────────────
  console.log("1 — Compose and send to a colleague:");
  const sent = await compose(alice.accessToken, {
    to: ["bob@acme.com"],
    subject: "E2E: Q3 numbers",
    bodyText: "Deck attached. Second paragraph a preview would cut.",
  });
  check("send reports one in-app delivery, nothing queued for SMTP",
    sent.deliveredInApp === 1 && sent.queuedExternal === 0);

  const bobRow = await waitFor("bob's mailbox shows the MAIL row", async () => {
    const p = await mailbox(bob.accessToken);
    return p.items.find((it) => it.refId === sent.mailId) ?? null;
  });
  check("row is kind MAIL", bobRow.itemKind === "MAIL");
  check("row is attributed to alice", bobRow.peerUserId === alice.user.id);
  check("row is unread", bobRow.unreadCount >= 1);
  // The feed carries no body; the preview is the subject plus a snippet, built
  // server-side, and is the only text the list has to render a row.
  check("preview joins subject and body", bobRow.preview.startsWith("E2E: Q3 numbers — Deck attached"));

  // ── 2. Full content, from both sides ─────────────────────────────────────
  console.log("\n2 — Open the mail:");
  const asBob = await getMail(bob.accessToken, sent.mailId);
  check("bob sees it in his INBOX", asBob.folder === "INBOX");
  check("body is complete, not the preview",
    asBob.bodyText === "Deck attached. Second paragraph a preview would cut.");
  check("From is alice's address", asBob.fromAddress === "alice@acme.com");
  check("To resolves to a local user", asBob.recipients.some((r) => r.kind === "TO" && r.userId === bob.user.id));

  const asAlice = await getMail(alice.accessToken, sent.mailId);
  check("the same row is alice's SENT copy", asAlice.folder === "SENT");

  // Carol was not addressed. Knowing the id must not be enough.
  const carolDenied = await rejectsWith(404, () =>
    api(BASE.msg, `/api/v1/mail/${sent.mailId}`, { token: carol.accessToken }),
  );
  check("a non-recipient cannot open it even knowing the id", carolDenied);

  // ── 3. Bcc privacy ───────────────────────────────────────────────────────
  console.log("\n3 — Bcc is visible to the author and the Bcc'd person only:");
  const bcc = await compose(alice.accessToken, {
    to: ["bob@acme.com"],
    bcc: ["carol@acme.com"],
    subject: "E2E: bcc",
    bodyText: "quietly copied",
  });
  await waitFor("carol receives the bcc'd mail", async () => {
    const p = await mailbox(carol.accessToken);
    return p.items.find((it) => it.refId === bcc.mailId) ?? null;
  });

  const bccAsBob = await getMail(bob.accessToken, bcc.mailId);
  check("the To: recipient sees NO bcc entry", bccAsBob.recipients.every((r) => r.kind !== "BCC"));

  const bccAsCarol = await getMail(carol.accessToken, bcc.mailId);
  check("the bcc'd person sees their OWN entry", bccAsCarol.recipients.some((r) => r.kind === "BCC"));

  const bccAsAlice = await getMail(alice.accessToken, bcc.mailId);
  check("the author sees the list they typed", bccAsAlice.recipients.some((r) => r.kind === "BCC"));

  // ── 4. Read state ────────────────────────────────────────────────────────
  console.log("\n4 — Opening a mail clears its badge:");
  await api(BASE.msg, `/api/v1/mail/${sent.mailId}/read`, {
    method: "POST", token: bob.accessToken, idem: uuid(),
  });
  const cleared = await waitFor("unread badge cleared", async () => {
    const p = await mailbox(bob.accessToken);
    const it = p.items.find((x) => x.refId === sent.mailId);
    return it && it.unreadCount === 0 ? it : null;
  });
  check("mark-read zeroed the row's unread count", !!cleared);
  const readMail = await getMail(bob.accessToken, sent.mailId);
  check("read_at is stamped", !!readMail.readAt);

  // ── 5. Delete is one-sided ───────────────────────────────────────────────
  console.log("\n5 — Deleting a mail affects only the person who deleted it:");
  await api(BASE.msg, `/api/v1/inbox/items/MAIL/${sent.mailId}/ignore`, {
    method: "POST", token: bob.accessToken, idem: uuid(),
  });
  const goneForBob = await waitFor("mail gone from bob's mailbox", async () => {
    const p = await mailbox(bob.accessToken);
    return p.items.every((it) => it.refId !== sent.mailId) ? true : null;
  });
  check("recipient's delete removed it from their mailbox", goneForBob);

  const stillAlice = await mailbox(alice.accessToken);
  check("the sender's Sent copy is untouched",
    stillAlice.items.some((it) => it.refId === sent.mailId));
  // The mail itself still exists — bob hid a row, he did not destroy anyone's
  // record of the correspondence.
  const stillReadable = await getMail(alice.accessToken, sent.mailId);
  check("the mail is still readable by the sender", stillReadable.subject === "E2E: Q3 numbers");

  // ── 6. Validation ────────────────────────────────────────────────────────
  console.log("\n6 — Validation rejects what SMTP would bounce:");
  const draft = await api<{ mailId: string }>(BASE.msg, "/api/v1/mail/drafts", {
    method: "POST", token: alice.accessToken,
  });
  const rejected = await rejectsWith(422, () =>
    api(BASE.msg, `/api/v1/mail/drafts/${draft.mailId}/send`, {
      method: "POST", token: alice.accessToken, idem: uuid(),
      body: { to: ["not-an-address"], cc: [], bcc: [], subject: "nope", bodyText: "" },
    }),
  );
  check("a malformed address is rejected with 422", rejected);

  const noRecipients = await rejectsWith(422, () =>
    api(BASE.msg, `/api/v1/mail/drafts/${draft.mailId}/send`, {
      method: "POST", token: alice.accessToken, idem: uuid(),
      body: { to: [], cc: [], bcc: [], subject: "nope", bodyText: "" },
    }),
  );
  check("a mail with no recipients is rejected with 422", noRecipients);

  // ── 7. Abandoned draft ───────────────────────────────────────────────────
  console.log("\n7 — Closing the composer discards the draft:");
  await api(BASE.msg, `/api/v1/mail/drafts/${draft.mailId}`, {
    method: "DELETE", token: alice.accessToken, idem: uuid(),
  });
  const draftGone = await rejectsWith(404, () =>
    api(BASE.msg, `/api/v1/mail/${draft.mailId}`, { token: alice.accessToken }),
  );
  check("the discarded draft is gone", draftGone);

  // A draft never reaches anyone's feed, sent or not.
  const aliceFeed = await mailbox(alice.accessToken);
  check("no draft ever appeared in a feed",
    aliceFeed.items.every((it) => it.refId !== draft.mailId));

  console.log(`\n── ${failures === 0 ? "ALL PASSED 🎉" : `${failures} FAILED`} ──`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
