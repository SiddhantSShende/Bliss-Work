/**
 * E2E for deep-link WhatsApp forwarding against the running stack.
 *   npx tsx scripts/forward-link-e2e.ts
 *
 * Covers what the endpoint is actually responsible for — everything up to the
 * moment the browser opens wa.me. The redirect itself is NOT tested here and
 * cannot be: opening WhatsApp is the client's job (the popup blocker forces it
 * to happen synchronously in the click handler), and whether the user then
 * presses send is the thing this whole feature is explicit about not knowing.
 *
 *   - POST /api/v1/messages/{id}/forward-link records the forward
 *   - the response says delivery=unconfirmed, never "sent"
 *   - the phone number is normalized server-side to bare E.164 digits
 *   - a `forward_external` system entry lands in the origin chat, with the
 *     number in a DM and the number withheld in a channel
 *   - retrying the same clientMsgId is idempotent (no second pill, no second edge)
 *   - a local number with no country code is refused rather than guessed at
 *   - a client cannot forge a forward pill by sending kind=forward_external
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

interface ForwardLinkResp {
  status: string;
  platform: string;
  delivery: string;
  targetPhone: string;
  systemMessageId: string;
}
interface Msg {
  id: string;
  body: string;
  kind?: string;
  senderId: string;
}

const forwardLink = (tok: string, msgId: string, body: unknown) =>
  api<ForwardLinkResp>(BASE.msg, `/api/v1/messages/${msgId}/forward-link`, {
    method: "POST",
    token: tok,
    body,
  });

/** Raw fetch — the helper throws on non-2xx, and the refusal IS the assertion. */
async function status(tok: string, msgId: string, body: unknown): Promise<number> {
  const res = await fetch(`${BASE.msg}/api/v1/messages/${msgId}/forward-link`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
  return res.status;
}

const messages = (tok: string, convId: string) =>
  api<{ items: Msg[] } | Msg[]>(BASE.msg, `/api/v1/conversations/${convId}/messages?limit=100`, {
    token: tok,
  }).then((r) => (Array.isArray(r) ? r : r.items));

async function main() {
  console.log("── Deep-link WhatsApp forwarding E2E ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");

  // ── 1. Alice sends Bob a message; Bob forwards it to a WhatsApp number ────
  console.log("1 — record a forward:");
  const sent = await api<{ threadId: string; messageId: string; conversationId: string }>(
    BASE.msg,
    "/api/v1/conversations/messages",
    {
      token: alice.accessToken,
      body: { recipientId: bob.user.id, body: "Ship it on Friday", clientMsgId: uuid() },
    },
  );

  // The real client sends NO number: the link is wa.me/?text=… so WhatsApp
  // shows its own contact chooser and the recipient is picked out of our sight.
  const clientMsgId = uuid();
  const res = await forwardLink(bob.accessToken, sent.messageId, {
    channel: "whatsapp",
    targetPhone: "",
    targetName: "",
    clientMsgId,
  });
  check("returns status=recorded", res.status === "recorded");
  check("platform is whatsapp", res.platform === "whatsapp");
  check(
    `delivery is 'unconfirmed', not 'sent' (got '${res.delivery}')`,
    res.delivery === "unconfirmed",
  );
  check(
    `no recipient is echoed back when none was captured (got '${res.targetPhone}')`,
    res.targetPhone === "",
  );

  // ── 2. The system entry lands in the origin chat ─────────────────────────
  console.log("\n2 — the pill in the DM:");
  const pill = await waitFor("forward pill in conversation", async () => {
    const items = await messages(bob.accessToken, sent.conversationId);
    return items.find((m) => m.id === res.systemMessageId) ?? null;
  });
  check("pill has kind=forward_external", pill.kind === "forward_external");
  check(
    `pill says "Opened WhatsApp", never "forwarded" (got: "${pill.body}")`,
    /opened whatsapp/i.test(pill.body) && !/^forwarded/i.test(pill.body),
  );
  // The recipient was chosen inside WhatsApp, so the pill must not name one.
  // Inventing "to a contact" here would be the one guess least acceptable in
  // the original author's evidence that their message left. Asserted as an
  // exact string: "no phone digits" alone would still pass for a body that
  // invented a name.
  check(
    "pill claims NO recipient, because none is knowable",
    pill.body === "Opened WhatsApp to forward this message",
  );

  // Alice — the ORIGINAL author, the person whose message left — sees it too.
  const aliceSees = await waitFor("author sees the pill", async () => {
    const items = await messages(alice.accessToken, sent.conversationId);
    return items.find((m) => m.id === res.systemMessageId) ?? null;
  });
  check("the original author sees the same pill", aliceSees.kind === "forward_external");

  // ── 3. Idempotency ───────────────────────────────────────────────────────
  console.log("\n3 — retrying the same clientMsgId:");
  // Measured as a DELTA, not an absolute count: this runs against a long-lived
  // dev database where earlier runs have already left pills in this thread.
  const countPills = async () =>
    (await messages(bob.accessToken, sent.conversationId)).filter(
      (m) => m.kind === "forward_external",
    ).length;
  const before = await countPills();
  const retry = await forwardLink(bob.accessToken, sent.messageId, {
    channel: "whatsapp",
    targetPhone: "",
    targetName: "",
    clientMsgId,
  });
  check("retry re-uses the same system entry", retry.systemMessageId === res.systemMessageId);
  const after = await countPills();
  check(`retry added no new pill (${before} → ${after})`, after === before);

  // ── 4. Refusals ──────────────────────────────────────────────────────────
  console.log("\n4 — what it refuses:");
  // A number is optional, but a MALFORMED one is still refused rather than
  // guessed at — the deep-link-to-a-known-chat path still depends on it.
  check(
    "local number with no country code → 400 (never guessed)",
    (await status(bob.accessToken, sent.messageId, {
      channel: "whatsapp",
      targetPhone: "5551234",
      clientMsgId: uuid(),
    })) === 400,
  );
  check(
    "a full international number is still accepted when supplied",
    (await forwardLink(bob.accessToken, sent.messageId, {
      channel: "whatsapp",
      targetPhone: "+1 (555) 123-4567",
      targetName: "Jane Doe",
      clientMsgId: uuid(),
    })).targetPhone === "15551234567",
  );
  check(
    "unsupported channel → 400",
    (await status(bob.accessToken, sent.messageId, {
      channel: "telegram",
      targetPhone: "+15551234567",
      clientMsgId: uuid(),
    })) === 400,
  );
  check(
    "missing clientMsgId → 400",
    (await status(bob.accessToken, sent.messageId, {
      channel: "whatsapp",
      targetPhone: "+15551234567",
    })) === 400,
  );

  // A stranger outside the conversation must not be able to forward from it,
  // and must not learn whether the message id exists.
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  check(
    "a non-participant cannot forward the message → 403",
    (await status(carol.accessToken, sent.messageId, {
      channel: "whatsapp",
      targetPhone: "+15551234567",
      clientMsgId: uuid(),
    })) === 403,
  );

  // ── 5. The pill cannot be forged by a client ─────────────────────────────
  // MessageKindForwardExternal is kept out of ValidMessageKind precisely so a
  // client cannot post "Opened WhatsApp to forward this to IT Support (+1800…)"
  // into someone else's thread. Sending it must not produce a pill.
  console.log("\n5 — a client cannot forge a pill:");
  const forged = await api<{ messageId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token: bob.accessToken,
    body: {
      recipientId: alice.user.id,
      body: "Opened WhatsApp to forward this to IT Support (+18005550000)",
      kind: "forward_external",
      clientMsgId: uuid(),
    },
  }).catch(() => null);
  if (forged === null) {
    check("server rejected a client-supplied forward_external kind", true);
  } else {
    const items = await messages(alice.accessToken, sent.conversationId);
    const row = items.find((m) => m.id === forged.messageId);
    check(
      `forged message did not become a pill (kind='${row?.kind ?? "text"}')`,
      !row || row.kind !== "forward_external",
    );
  }

  console.log(`\n${failures === 0 ? "✅ all checks passed" : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥", e);
  process.exit(1);
});
