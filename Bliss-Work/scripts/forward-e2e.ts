/**
 * E2E for in-workspace forwarding against the running stack.
 *   npx tsx scripts/forward-e2e.ts
 *
 * The sibling script (forward-link-e2e.ts) covers the wa.me deep link, which
 * delivers nothing and records 'unconfirmed'. This covers the forward that DOES
 * deliver, and the one thing that makes it more than a copy-paste of the body:
 *
 *   - POST /api/v1/messages/{id}/forward delivers to a person and to a channel
 *   - the delivered copy is marked isForward, so the reader is told
 *   - MEDIA re-scoping: the copy carries DIFFERENT attachment ids, the recipient
 *     can fetch them, and the ORIGINAL ids stay unreadable to them
 *   - retrying the same clientMsgId is idempotent
 *   - it refuses a source you cannot read and a destination you cannot post to
 *
 * The media assertion is the point of the whole feature. Attachments are
 * authorized by (scope, scope_id), so a body copied verbatim would hand the
 * recipient ids they are not a member of and every tile would render as
 * unavailable — which is why forwarding media used to be hidden outright.
 *
 * Exits non-zero on any failed assertion.
 */
import { BASE, createOrgOrLogin, inviteAndAccept, api, waitFor, type Session } from "./_tb";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!ok) failures++;
}

const uuid = () => crypto.randomUUID();
/** U+001F — the sentinel chatEnvelope.ts puts between the readable prefix and
 *  the JSON payload. */
const SENTINEL = String.fromCharCode(0x1f);

interface ForwardResp {
  messageId: string;
  conversationId?: string;
  channelId?: string;
  delivery: string;
}
interface Msg {
  id: string;
  body: string;
  senderId: string;
  isForward?: boolean;
}
interface ChannelMsg extends Msg {
  channelId: string;
}

const forward = (tok: string, msgId: string, body: unknown) =>
  api<ForwardResp>(BASE.msg, `/api/v1/messages/${msgId}/forward`, {
    method: "POST",
    token: tok,
    body,
  });

/** Raw fetch — the helper throws on non-2xx, and the refusal IS the assertion. */
async function status(tok: string, msgId: string, body: unknown): Promise<number> {
  const res = await fetch(`${BASE.msg}/api/v1/messages/${msgId}/forward`, {
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

const channelMessages = (tok: string, channelId: string) =>
  api<{ items: ChannelMsg[] } | ChannelMsg[]>(
    BASE.msg,
    `/api/v1/channels/${channelId}/messages?limit=100`,
    { token: tok },
  ).then((r) => (Array.isArray(r) ? r : r.items));

/** Which of `ids` this caller is allowed to fetch. The links endpoint answers
 *  only for attachments whose scope the caller is a member of, so this is the
 *  authorization question asked directly. */
const readableIds = (tok: string, ids: string[]) =>
  api<{ id: string; url: string }[]>(BASE.msg, "/api/v1/attachments/links", {
    method: "POST",
    token: tok,
    body: { ids },
  }).then((links) => links.map((l) => l.id));

/** Upload one file into a scope, exactly as the composer does. */
async function upload(
  tok: string,
  scope: string,
  scopeId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", new Blob([bytes.slice().buffer], { type: "image/png" }), name);
  const res = await fetch(
    `${BASE.msg}/api/v1/attachments?scope=${scope}&scopeId=${scopeId}`,
    { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: form },
  );
  if (!res.ok) throw new Error(`upload → ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** The attachment ids a media body references. */
function idsIn(body: string): string[] {
  const i = body.indexOf(SENTINEL);
  if (i < 0) return [];
  const env = JSON.parse(body.slice(i + 1)) as { items?: { id?: string }[] };
  return (env.items ?? []).map((it) => it.id!).filter(Boolean);
}

const sendDM = (from: Session, toId: string, body: string) =>
  api<{ messageId: string; conversationId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token: from.accessToken,
    body: { recipientId: toId, body, clientMsgId: uuid() },
  });

async function main() {
  console.log("── In-workspace forwarding E2E ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");

  // ── 1. Forward a text message to another person ──────────────────────────
  console.log("1 — forward a message to a person:");
  const sent = await sendDM(alice, bob.user.id, "Ship it on Friday");

  const clientMsgId = uuid();
  const toCarol = await forward(bob.accessToken, sent.messageId, {
    targetKind: "user",
    targetId: carol.user.id,
    clientMsgId,
  });
  check("delivery is 'confirmed' — the copy is in the database", toCarol.delivery === "confirmed");
  check("the destination conversation is echoed back", !!toCarol.conversationId);

  const delivered = await waitFor("Carol receives the forward", async () => {
    const items = await messages(carol.accessToken, toCarol.conversationId!);
    return items.find((m) => m.id === toCarol.messageId) ?? null;
  });
  check("the body arrives intact", delivered.body === "Ship it on Friday");
  check("it is attributed to the forwarder, not the original author", delivered.senderId === bob.user.id);
  // Without this the copy is indistinguishable from something Bob wrote.
  check("it is marked as a forward for the reader", delivered.isForward === true);

  // ── 2. Idempotency ───────────────────────────────────────────────────────
  console.log("\n2 — retrying the same clientMsgId:");
  const countIn = async (convId: string) =>
    (await messages(carol.accessToken, convId)).filter((m) => m.isForward).length;
  const before = await countIn(toCarol.conversationId!);
  const retry = await forward(bob.accessToken, sent.messageId, {
    targetKind: "user",
    targetId: carol.user.id,
    clientMsgId,
  });
  check("retry re-uses the delivered message", retry.messageId === toCarol.messageId);
  const after = await countIn(toCarol.conversationId!);
  check(`retry delivered nothing new (${before} → ${after})`, after === before);

  // ── 3. MEDIA: the attachment is re-scoped to the destination ─────────────
  console.log("\n3 — forwarding a photo into a channel:");
  const dm = await sendDM(alice, bob.user.id, "here it is");
  // A real PNG signature: the server sniffs the TYPE FROM THE BYTES and never
  // trusts the declared Content-Type, so arbitrary bytes would be stored as
  // application/octet-stream and the assertion would be testing the wrong path.
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const att = await upload(
    alice.accessToken,
    "conversation",
    dm.conversationId,
    "photo.png",
    png,
  );
  const mediaBody =
    `🖼️ photo.png · 12 B${SENTINEL}` +
    JSON.stringify({
      v: 2,
      kind: "media",
      items: [{ id: att.id, name: "photo.png", size: png.length, mime: "image/png" }],
    });
  const mediaMsg = await api<{ messageId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token: alice.accessToken,
    body: { recipientId: bob.user.id, body: mediaBody, clientMsgId: uuid() },
  });
  await api(BASE.msg, `/api/v1/attachments/${att.id}/commit`, {
    method: "POST",
    token: alice.accessToken,
  });

  const channel = await api<{ id: string }>(BASE.msg, "/api/v1/channels", {
    token: bob.accessToken,
    body: { name: `fwd-${Date.now()}`, memberIds: [carol.user.id] },
  });

  const toChannel = await forward(bob.accessToken, mediaMsg.messageId, {
    targetKind: "channel",
    targetId: channel.id,
    clientMsgId: uuid(),
  });
  const inChannel = await waitFor("the photo arrives in the channel", async () => {
    const items = await channelMessages(carol.accessToken, channel.id);
    return items.find((m) => m.id === toChannel.messageId) ?? null;
  });

  const originalIds = idsIn(mediaBody);
  const forwardedIds = idsIn(inChannel.body);
  check("the forwarded body still carries a media envelope", forwardedIds.length === 1);
  check(
    "the attachment was RE-SCOPED — the ids are not the originals",
    forwardedIds.length === 1 && forwardedIds[0] !== originalIds[0],
  );
  check("the channel copy is marked as a forward", inChannel.isForward === true);

  // The whole point: a member of the destination can open the file even though
  // they were never in the conversation it was uploaded to.
  check(
    "a channel member can fetch the forwarded attachment",
    (await readableIds(carol.accessToken, forwardedIds)).length === 1,
  );
  // And the original stays where it was. A forward that granted access to the
  // source rows would leak the whole DM's media to the channel.
  check(
    "the ORIGINAL attachment stays unreadable to her",
    (await readableIds(carol.accessToken, originalIds)).length === 0,
  );

  // ── 4. Refusals ──────────────────────────────────────────────────────────
  console.log("\n4 — what it refuses:");
  check(
    "a non-participant cannot forward from a DM → 403",
    (await status(carol.accessToken, sent.messageId, {
      targetKind: "user",
      targetId: alice.user.id,
      clientMsgId: uuid(),
    })) === 403,
  );
  // Alice created neither the channel nor a membership in it.
  check(
    "cannot forward INTO a channel you are not in → 403",
    (await status(alice.accessToken, mediaMsg.messageId, {
      targetKind: "channel",
      targetId: channel.id,
      clientMsgId: uuid(),
    })) === 403,
  );
  check(
    "an unknown targetKind → 400",
    (await status(bob.accessToken, sent.messageId, {
      targetKind: "email",
      targetId: carol.user.id,
      clientMsgId: uuid(),
    })) === 400,
  );
  check(
    "missing clientMsgId → 400 (a retry must be a retry, not a second delivery)",
    (await status(bob.accessToken, sent.messageId, {
      targetKind: "user",
      targetId: carol.user.id,
    })) === 400,
  );

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
