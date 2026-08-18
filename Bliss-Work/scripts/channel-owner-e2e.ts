/**
 * E2E for channel ownership against the running stack.
 *   npx tsx scripts/channel-owner-e2e.ts
 *
 * 0012_channel_roles introduced owner/admin/member and backfilled owners for
 * the channels that existed then — but CreateChannel kept inserting the column
 * default, so every channel created SINCE had no owner at all. The creator got
 * no "Add people" (the client hides an action the server would refuse) and
 * nobody but an org admin could moderate the channel.
 *
 * What this pins:
 *   - creating a channel makes the creator its OWNER, in the create response
 *     and in the channel list
 *   - the creator can then add members, change roles, and kick
 *   - someone added to the channel is an ordinary member, not an owner
 *   - a self-joiner of an open channel is an ordinary member either way
 *
 * Exits non-zero on any failed assertion.
 */
import { BASE, createOrgOrLogin, inviteAndAccept, api } from "./_tb";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
  if (!ok) failures++;
}

interface Channel {
  id: string;
  name: string;
  myRole: string;
  memberCount: number;
}
interface RosterRow {
  userId: string;
  role: string;
  blocked: boolean;
}

const channels = (tok: string) => api<Channel[]>(BASE.msg, "/api/v1/channels", { token: tok });
const roster = (tok: string, id: string) =>
  api<RosterRow[]>(BASE.msg, `/api/v1/channels/${id}/members/roster`, { token: tok });

/** Raw fetch — the helper throws on non-2xx, and the status IS the assertion. */
async function status(tok: string, path: string, method: string, body?: unknown): Promise<number> {
  const res = await fetch(`${BASE.msg}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
}

async function main() {
  console.log("── Channel ownership E2E ──\n");

  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  // Bob is an ordinary MEMBER of the org, not an org admin. That is the case
  // the bug was reported for: an org admin could always moderate any channel,
  // so the breakage was invisible to whoever tested it as one.
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");

  console.log("1 — a member creates a channel:");
  const created = await api<Channel>(BASE.msg, "/api/v1/channels", {
    token: bob.accessToken,
    body: { name: `owners-${Date.now()}`, memberIds: [] },
  });
  check(`the create response says myRole=owner (got '${created.myRole}')`, created.myRole === "owner");

  const mine = (await channels(bob.accessToken)).find((c) => c.id === created.id);
  check("the channel list agrees", mine?.myRole === "owner");
  const rows = await roster(bob.accessToken, created.id);
  check(
    "the roster records the creator as owner",
    rows.find((r) => r.userId === bob.user.id)?.role === "owner",
  );

  console.log("\n2 — and can therefore run their own channel:");
  check(
    "the creator can add a member → 204",
    (await status(bob.accessToken, `/api/v1/channels/${created.id}/members`, "POST", {
      memberIds: [carol.user.id],
    })) === 204,
  );
  const after = await roster(bob.accessToken, created.id);
  check(
    "the person added is an ordinary member, not an owner",
    after.find((r) => r.userId === carol.user.id)?.role === "member",
  );
  // Role changes are OWNER-only (an admin cannot mint more admins), so this
  // passing is the whole permission model working for the creator.
  check(
    "the creator can promote them to admin → 204",
    (await status(
      bob.accessToken,
      `/api/v1/channels/${created.id}/members/${carol.user.id}`,
      "PATCH",
      { role: "admin" },
    )) === 204,
  );
  check(
    "the creator can remove them again → 204",
    (await status(
      bob.accessToken,
      `/api/v1/channels/${created.id}/members/${carol.user.id}`,
      "DELETE",
    )) === 204,
  );

  console.log("\n3 — self-joining an open channel claims nothing:");
  check(
    "a self-join succeeds → 204",
    (await status(carol.accessToken, `/api/v1/channels/${created.id}/join`, "POST")) === 204,
  );
  const joined = (await channels(carol.accessToken)).find((c) => c.id === created.id);
  check(`the joiner is a member (got '${joined?.myRole}')`, joined?.myRole === "member");

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
