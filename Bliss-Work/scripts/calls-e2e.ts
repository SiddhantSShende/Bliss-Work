/**
 * End-to-end exercise of the CALL surface against a running stack.
 *
 *   npx tsx scripts/calls-e2e.ts
 *
 * Covers every route in services/messaging-svc/internal/api/calls.go, both the
 * happy paths and the refusals — 400/401/403/404/409 — plus the two things that
 * are only true across an org boundary: a meeting link is the one way in, and
 * everything else stays refused.
 *
 * Written as a script rather than a Go test because the interesting behaviour is
 * the composition of auth-svc's JWTs, messaging-svc's RLS and the SFU token
 * mint; a unit test with a fake claims struct proves none of it.
 */
import { BASE, PASSWORD, api, createOrgOrLogin, inviteAndAccept, type Session } from "./_tb";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Raw fetch that returns status + parsed body, so refusals can be asserted. */
async function raw(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; base?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${opts.base ?? BASE.msg}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text().catch(() => "");
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log("Calls E2E against", BASE.msg, "\n");

  // ── Actors ────────────────────────────────────────────────────────────────
  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const carol = await inviteAndAccept(alice, "carol@acme.com", "carol", "Carol Singer");
  // A SECOND organisation. Its member shares no org with anyone above, which is
  // what makes the cross-org assertions meaningful.
  const dave = await createOrgOrLogin("Globex", "globex", "dave@globex.com", "Dave Outside");
  console.log(`actors: alice=${alice.user.id} bob=${bob.user.id} carol=${carol.user.id}`);
  console.log(`        dave=${dave.user.id} (org ${dave.user.orgId} ≠ ${alice.user.orgId})\n`);

  // ── 1. Authentication ─────────────────────────────────────────────────────
  console.log("1. authentication");
  ok("GET /calls with no token → 401", (await raw("/api/v1/calls")).status === 401);
  ok(
    "GET /calls with a junk token → 401",
    (await raw("/api/v1/calls", { token: "not.a.jwt" })).status === 401,
  );
  {
    const r = await raw("/api/v1/calls", { token: alice.accessToken });
    ok("GET /calls with a real token → 200 array", r.status === 200 && Array.isArray(r.body));
  }

  // ── 2. Schedule a meeting ─────────────────────────────────────────────────
  console.log("\n2. POST /meetings");
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const created = await raw("/api/v1/meetings", {
    token: alice.accessToken,
    body: { title: "E2E audit meeting", media: "video", scheduledAt: soon, inviteeIds: [bob.user.id] },
  });
  ok("→ 201", created.status === 201, JSON.stringify(created.body).slice(0, 200));
  const meeting = created.body;
  ok("payload has id/kind/status", meeting?.kind === "MEETING" && meeting?.status === "SCHEDULED");
  ok("payload carries the roster", Array.isArray(meeting?.participants) && meeting.participants.length >= 2);
  ok(
    "organiser is HOST, invitee is PARTICIPANT",
    meeting?.participants?.find((p: any) => p.userId === alice.user.id)?.role === "HOST" &&
      meeting?.participants?.find((p: any) => p.userId === bob.user.id)?.role === "PARTICIPANT",
  );
  ok("createdBy is the organiser", meeting?.createdBy === alice.user.id);

  console.log("\n2b. POST /meetings validation");
  ok(
    "media must be audio|video → 400",
    (await raw("/api/v1/meetings", { token: alice.accessToken, body: { media: "hologram" } })).status === 400,
  );
  ok(
    "scheduledAt must be RFC3339 → 400",
    (await raw("/api/v1/meetings", { token: alice.accessToken, body: { scheduledAt: "tomorrow" } })).status === 400,
  );
  ok(
    "an invitee id that is not a uuid → 400",
    (await raw("/api/v1/meetings", { token: alice.accessToken, body: { inviteeIds: ["nope"] } })).status === 400,
  );
  ok(
    "more than 200 invitees → 400",
    (
      await raw("/api/v1/meetings", {
        token: alice.accessToken,
        body: { inviteeIds: Array.from({ length: 201 }, () => crypto.randomUUID()) },
      })
    ).status === 400,
  );
  ok(
    "a malformed JSON body → 400",
    (
      await fetch(`${BASE.msg}/api/v1/meetings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
        body: "{",
      })
    ).status === 400,
  );
  {
    // A non-ASCII title longer than the 200-byte cap must not be cut mid-rune —
    // invalid UTF-8 is rejected outright by Postgres for a text column.
    const long = "प्रबंधन".repeat(40); // ≈ 840 bytes
    const r = await raw("/api/v1/meetings", { token: alice.accessToken, body: { title: long } });
    ok("an over-long Devanagari title is truncated on a rune boundary, not rejected", r.status === 201);
    if (r.status === 201) await raw(`/api/v1/calls/${r.body.id}/end`, { method: "POST", token: alice.accessToken });
  }

  // ── 3. Identity / not-found handling ──────────────────────────────────────
  console.log("\n3. bad ids");
  ok("GET /calls/{not-a-uuid} → 400", (await raw("/api/v1/calls/abc", { token: alice.accessToken })).status === 400);
  {
    const r = await raw(`/api/v1/calls/${crypto.randomUUID()}`, { token: alice.accessToken });
    ok("GET /calls/{unknown uuid} → 403 or 404", r.status === 403 || r.status === 404, `got ${r.status}`);
  }

  // ── 4. The waiting room ───────────────────────────────────────────────────
  console.log("\n4. POST /calls/{id}/token — the lobby");
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: bob.accessToken });
    ok("an invitee on a SCHEDULED call → 202 WAITING", r.status === 202 && r.body?.state === "WAITING", `got ${r.status}`);
    ok("…and is told they may not start it", r.body?.canStart === false);
    ok("…and is handed NO token", !r.body?.token);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/start`, { method: "POST", token: bob.accessToken });
    ok("an invitee starting it → 403", r.status === 403, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: carol.accessToken });
    ok("someone not on the roster → 403", r.status === 403, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: dave.accessToken });
    ok("someone in another org → 403", r.status === 403, `got ${r.status}`);
  }
  {
    // The organiser is entitled to start it, so they are never held in a lobby.
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: alice.accessToken });
    ok("the organiser → 202 WAITING with canStart", r.status === 202 && r.body?.canStart === true, `got ${r.status}`);
  }

  // ── 5. Start, and the room token ──────────────────────────────────────────
  console.log("\n5. POST /calls/{id}/start");
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/start`, { method: "POST", token: alice.accessToken });
    ok("the organiser starts it → 200 LIVE", r.status === 200 && r.body?.status === "LIVE", `got ${r.status}`);
    ok("startedAt is stamped", !!r.body?.startedAt);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/start`, { method: "POST", token: alice.accessToken });
    ok("starting a live call again is idempotent → 200", r.status === 200, `got ${r.status}`);
  }
  let bobRoomToken = "";
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: bob.accessToken });
    ok("the invitee now gets a room token → 200 JOINED", r.status === 200 && r.body?.state === "JOINED", `got ${r.status}`);
    ok("…with url + token + expiresAt", !!r.body?.url && !!r.body?.token && !!r.body?.expiresAt);
    ok("…identity is the caller's user id", r.body?.identity === bob.user.id);
    ok("…role is PARTICIPANT, not HOST", r.body?.role === "PARTICIPANT", `got ${r.body?.role}`);
    ok("…room is the call id", r.body?.room === meeting.id);
    bobRoomToken = r.body?.token ?? "";
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: alice.accessToken });
    ok("the organiser's grant is HOST", r.body?.role === "HOST", `got ${r.body?.role}`);
  }
  if (bobRoomToken) {
    // The room token is a JWT the SFU verifies. Decode it here rather than
    // trusting the mint: a token that names the wrong room is the failure that
    // presents as "the call connects and nobody is there".
    const [, payload] = bobRoomToken.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    ok("room JWT names the call as its room", claims?.video?.room === meeting.id, JSON.stringify(claims?.video));
    ok("room JWT allows publishing and screen share", claims?.video?.canPublish === true);
    ok("room JWT does NOT grant roomAdmin to a participant", !claims?.video?.roomAdmin);
    ok("room JWT expires", typeof claims?.exp === "number" && claims.exp * 1000 > Date.now());
  }

  // ── 6. Screen sharing ─────────────────────────────────────────────────────
  console.log("\n6. POST /calls/{id}/share");
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/share`, {
      token: bob.accessToken,
      body: { source: "monitor" },
    });
    ok("a participant starts sharing → 201", r.status === 201, `got ${r.status}`);
    ok("the record names the sharer", r.body?.userId === bob.user.id, JSON.stringify(r.body));
    ok("…and what they picked", !!r.body?.source);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}`, { token: alice.accessToken });
    ok(
      "everyone in the call can see who is sharing",
      r.body?.activeShares?.some((sh: any) => sh.userId === bob.user.id),
      JSON.stringify(r.body?.activeShares),
    );
  }
  {
    // There is no target parameter, by design — so this can only ever stop the
    // CALLER's own share, and alice has none.
    const r = await raw(`/api/v1/calls/${meeting.id}/share/stop`, { method: "POST", token: alice.accessToken });
    ok("you cannot stop somebody else's share → 4xx", r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/share/stop`, { method: "POST", token: bob.accessToken });
    ok("the sharer stops their own → 204", r.status === 204, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}`, { token: alice.accessToken });
    const shares = r.body?.activeShares;
    ok("…and the room's record clears", Array.isArray(shares) && shares.length === 0, JSON.stringify(shares));
  }

  // ── 7. Add people ─────────────────────────────────────────────────────────
  console.log("\n7. POST /calls/{id}/participants");
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/participants`, {
      token: alice.accessToken,
      body: { userId: carol.user.id },
    });
    ok("adding someone from my org → 200", r.status === 200, `got ${r.status}`);
    ok(
      "…and they appear on the roster",
      r.body?.participants?.some((p: any) => p.userId === carol.user.id),
    );
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: carol.accessToken });
    ok("…so they can now join", r.status === 200 && r.body?.state === "JOINED", `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/participants`, {
      token: alice.accessToken,
      body: { userId: dave.user.id },
    });
    ok("adding someone from ANOTHER org → refused", r.status >= 400, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/participants`, {
      token: alice.accessToken,
      body: { userId: "not-a-uuid" },
    });
    ok("a non-uuid userId → 400", r.status === 400, `got ${r.status}`);
  }

  // ── 8. Invite links — the one cross-org door ──────────────────────────────
  console.log("\n8. invite links");
  let inviteToken = "";
  let inviteId = "";
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/invites`, {
      token: alice.accessToken,
      body: { ttlSeconds: 3600 },
    });
    ok("the host mints a link → 201", r.status === 201, `got ${r.status}`);
    ok("…and the token is in the body exactly once", !!r.body?.token);
    ok("…with an expiry", !!r.body?.expiresAt);
    inviteToken = r.body?.token ?? "";
    inviteId = r.body?.id ?? "";
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/invites`, {
      token: carol.accessToken,
      body: {},
    });
    ok("a plain participant cannot mint one → 403", r.status === 403, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/invites`, {
      token: alice.accessToken,
      body: { maxUses: 0 },
    });
    ok("maxUses must be positive → 400", r.status === 400, `got ${r.status}`);
  }
  {
    const r = await raw("/api/v1/calls/join", { token: dave.accessToken, body: { token: inviteToken } });
    ok("someone in ANOTHER org redeems it → 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ok(
      "…and is marked external on the roster",
      r.body?.participants?.find((p: any) => p.userId === dave.user.id)?.external === true,
    );
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: dave.accessToken });
    ok("…and can now get a room token", r.status === 200 && r.body?.state === "JOINED", `got ${r.status}`);
  }
  {
    const r = await raw("/api/v1/calls/join", { token: carol.accessToken, body: { token: "garbage" } });
    ok("an unknown token → 404, never 403", r.status === 404, `got ${r.status}`);
  }
  {
    const r = await raw("/api/v1/calls/join", { token: carol.accessToken, body: { token: "x".repeat(400) } });
    ok("an over-long token is refused without a db round trip → 404", r.status === 404, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/invites/${inviteId}`, {
      token: alice.accessToken,
      method: "DELETE",
    });
    ok("the host revokes it → 204", r.status === 204, `got ${r.status}`);
  }
  {
    const r = await raw("/api/v1/calls/join", { token: carol.accessToken, body: { token: inviteToken } });
    ok("…and a revoked link stops working → 404", r.status === 404, `got ${r.status}`);
  }

  // ── 9. Channel calls ──────────────────────────────────────────────────────
  console.log("\n9. channel calls");
  const channel: any = await api(BASE.msg, "/api/v1/channels", {
    token: alice.accessToken,
    body: { name: `e2e-calls-${Date.now()}`, visibility: "PUBLIC" },
  });
  let channelCall: any;
  {
    const r = await raw(`/api/v1/channels/${channel.id}/calls`, {
      token: alice.accessToken,
      body: { title: "Standup", media: "audio" },
    });
    ok("a channel call with no scheduledAt starts LIVE → 201", r.status === 201, `got ${r.status}`);
    ok("…kind is CHANNEL and it names its channel", r.body?.kind === "CHANNEL" && r.body?.channelId === channel.id);
    channelCall = r.body;
  }
  {
    const r = await raw(`/api/v1/channels/${channel.id}/calls`, { token: alice.accessToken });
    ok("GET lists it", r.status === 200 && r.body?.some((c: any) => c.id === channelCall.id));
  }
  {
    const r = await raw(`/api/v1/calls/${channelCall.id}/invites`, { token: alice.accessToken, body: {} });
    ok("a channel call refuses to mint a link → 4xx", r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${channelCall.id}/token`, { method: "POST", token: dave.accessToken });
    ok("someone outside the org cannot get a channel-call token → 403", r.status === 403, `got ${r.status}`);
  }

  // ── 10. Direct calls ──────────────────────────────────────────────────────
  console.log("\n10. direct calls");
  let direct: any;
  {
    const r = await raw("/api/v1/calls/direct", {
      token: alice.accessToken,
      body: { peerId: bob.user.id, media: "audio" },
    });
    ok("ring now → 201 DIRECT", r.status === 201 && r.body?.kind === "DIRECT", `got ${r.status}`);
    direct = r.body;
  }
  {
    const r = await raw("/api/v1/calls/direct", {
      token: alice.accessToken,
      body: { peerId: bob.user.id, media: "video", scheduledAt: soon, title: "1:1" },
    });
    ok("schedule for later → 201 SCHEDULED", r.status === 201 && r.body?.status === "SCHEDULED", `got ${r.status}`);
    if (r.status === 201) await raw(`/api/v1/calls/${r.body.id}/end`, { method: "POST", token: alice.accessToken });
  }
  {
    const r = await raw("/api/v1/calls/direct", {
      token: alice.accessToken,
      body: { peerId: dave.user.id, media: "audio" },
    });
    ok("a peer in another org → refused", r.status >= 400, `got ${r.status}`);
  }
  {
    const r = await raw("/api/v1/calls/direct", { token: alice.accessToken, body: { peerId: "nope" } });
    ok("a non-uuid peerId → 400", r.status === 400, `got ${r.status}`);
  }

  // ── 11. The list every client reads ───────────────────────────────────────
  console.log("\n11. GET /calls");
  {
    const r = await raw("/api/v1/calls", { token: alice.accessToken });
    const ids = (r.body ?? []).map((c: any) => c.id);
    ok("the organiser sees their meeting", ids.includes(meeting.id));
    ok("…their channel call", ids.includes(channelCall.id));
    ok("…and their 1:1", ids.includes(direct.id));
    ok(
      "every row carries what the UI renders",
      (r.body ?? []).every(
        (c: any) => c.id && c.kind && c.status && c.createdAt && Array.isArray(c.participants),
      ),
    );
  }
  {
    const r = await raw("/api/v1/calls", { token: dave.accessToken });
    const ids = (r.body ?? []).map((c: any) => c.id);
    ok("the external guest sees the meeting they were let into", ids.includes(meeting.id));
    ok("…and NOTHING else of that org", !ids.includes(channelCall.id) && !ids.includes(direct.id));
  }

  // ── 12. Leaving and ending ────────────────────────────────────────────────
  console.log("\n12. leave / end");
  ok(
    "a participant leaves → 204",
    (await raw(`/api/v1/calls/${meeting.id}/leave`, { method: "POST", token: carol.accessToken })).status === 204,
  );
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/end`, { method: "POST", token: carol.accessToken });
    ok("a participant cannot end it for everyone → 403", r.status === 403, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/end`, { method: "POST", token: alice.accessToken });
    ok("the host ends it → 204", r.status === 204, `got ${r.status}`);
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}`, { token: alice.accessToken });
    ok("…and the call reads ENDED", r.body?.status === "ENDED", JSON.stringify(r.body?.status));
  }
  {
    const r = await raw(`/api/v1/calls/${meeting.id}/token`, { method: "POST", token: bob.accessToken });
    ok("…nobody can get a room token for it any more → 4xx", r.status >= 400, `got ${r.status}`);
  }
  await raw(`/api/v1/calls/${channelCall.id}/end`, { method: "POST", token: alice.accessToken });
  await raw(`/api/v1/calls/${direct.id}/end`, { method: "POST", token: alice.accessToken });

  // ── 13. CORS ──────────────────────────────────────────────────────────────
  console.log("\n13. CORS");
  {
    const res = await fetch(`${BASE.msg}/api/v1/calls`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    ok("preflight from the web origin is allowed", res.status < 400, `got ${res.status}`);
    ok(
      "…and echoes the origin",
      res.headers.get("access-control-allow-origin") === "http://localhost:5173",
      String(res.headers.get("access-control-allow-origin")),
    );
    ok("…with credentials", res.headers.get("access-control-allow-credentials") === "true");
  }
  {
    const res = await fetch(`${BASE.msg}/api/v1/calls`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    ok(
      "an unknown origin is not echoed back",
      res.headers.get("access-control-allow-origin") !== "https://evil.example",
      String(res.headers.get("access-control-allow-origin")),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("failures:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

void PASSWORD;
void ((): Session | undefined => undefined)();

main().catch((e) => {
  console.error("\nE2E aborted:", e);
  process.exit(2);
});
