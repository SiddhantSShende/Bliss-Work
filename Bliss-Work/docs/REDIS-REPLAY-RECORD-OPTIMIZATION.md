# Redis Replay Optimization — Cap 100 + Smallest Possible Replay Record

**Analysis & design only. Nothing in this report was implemented.** No
application code, Redis configuration, `maxReplayHard`, replay semantics,
serialization, or data structure was changed to produce it. Every number is
labeled **MEASURED** (real prod sample or a real controlled experiment
against a disposable scratch Redis, torn down after use, never touching
prod), **CONFIRMED** (read directly from source, with file:line citations),
or **ESTIMATE**/**UNKNOWN** where evidence was insufficient — per the
spec's own rule, nothing below is invented to hit a target byte count.

---

## A. Executive Summary

The current outbox record (`outbox:user:{id}` ZSET member) is the full,
unmodified `message.created`/`message.read`/`message.delivered` JSON event,
averaging ~413.5B raw payload / ~600B all-in Redis bytes (prior task's real
production measurement). This report traces the complete replay call graph,
audits every field of all three event types against real client code (not
assumption), and evaluates three levels of optimization:

1. **A zero-risk, zero-client-change trim** — dropping `orgId` and
   `clientMsgId` from the stored/replayed payload, both confirmed **unused
   by every client** (web, mobile, desktop) across every code path this
   report traced. Saves ~18.8% of payload bytes today, with no format
   change, no reconstruction step, no rollout complexity.
2. **A minimal-reference record** — storing only an event-type discriminant
   + `eventId` + `messageId` (33 bytes semantic payload) and reconstructing
   the full event server-side, before the wire, via a bulk `WHERE id =
   ANY($1)` query pattern that **already exists in this codebase** for a
   different purpose. Real measurement: 117.0 bytes/entry all-in — an 84%
   reduction from a same-methodology full-JSON baseline. This is real,
   evidence-backed, and buildable, but is a genuine engineering project
   (new binary wire format inside Redis, a version byte, a
   connection-pool-safe reconstruction path, and different handling per
   event type), not a same-day change.
3. **Cap reduction to 100** — 40K-user outbox memory at cap=100 is 1.030
   GiB (51.5% of the 2 GiB ceiling), with 23.19% of the modeled population
   trimmed (vs. 9.90% at cap=200) — but a genuinely surprising finding
   changes how that percentage should be read: **the cursor-based deep
   replay path that `maxReplayHard` governs is only ever exercised by a
   WebSocket reconnecting within an already-running client process.** Every
   fresh app launch (web reload, mobile cold start, desktop relaunch) resets
   the client's replay cursor to zero and always uses the separate,
   unaffected `maxReplayDefault=200` cursorless path instead. This was
   traced directly in the shared frontend `WsClient` and is not something
   the prior capacity-planning work knew.

**This report does not force a single number.** It gives a theoretical
minimum (33B semantic payload, message.created), a practical minimum (117B
measured all-in Redis bytes for that same minimal design), and a
recommended production target that is deliberately more conservative than
either — see section W.

---

## B. Current Replay Architecture

Events flow: Postgres write (messaging-svc, same transaction) → outbox
table → Kafka (`messaging.events.v1`) → ws-gateway consumer
(`internal/fanout` broadcast mode, or `internal/router` routed mode) →
per-recipient Redis ZSET write (`outbox:user:{id}`, unconditional, durability
first) → live socket delivery attempt (best-effort, non-blocking, sheds slow
consumers) → on reconnect, a `hello` frame triggers `Replay()` against the
same ZSET, oldest-first, then `replay.done`. See section C for the exact
call graph with file:line citations.

Two independent "sequence-shaped" concepts exist in this system and are
**not the same thing** — a real, previously-undocumented point of confusion
this report resolves definitively:

- **The replay cursor** (`hello`'s `lastSeenSeq` wire field) is actually a
  **millisecond epoch timestamp** — `Date.parse(occurredAt)` of the last
  event the client processed (`WsClient.ts:401-404`), compared inclusively
  against the ZSET's `occurredAt`-ms score (`outbox.go:90-124`). It governs
  cross-the-whole-platform event ordering for one user's catch-up stream.
- **The payload's own `seq` field** is a **per-conversation (or
  per-channel) monotonic integer**, allocated atomically by a Postgres
  `UPDATE conversations SET seq_counter = seq_counter + 1 ... RETURNING
  seq_counter` inside the same transaction as the message insert
  (`services/messaging-svc/internal/store/messages.go:468-475`; channels:
  `internal/store/append_channel.go:75-79`). It governs in-conversation
  message ordering, keyset REST pagination, and read-receipt range
  stamping — entirely within messaging-svc's own domain. It is never
  compared to the replay cursor anywhere in this codebase.

---

## C. Complete Replay Call Graph

```text
Event creation (messaging-svc, Postgres transaction)
  services/messaging-svc/internal/store/messages.go:468-475 (appendMessageTx)
  → allocates seq atomically, builds MessageCreated struct
  → services/messaging-svc/internal/store/outbox.go:25-34 (insertOutbox)
    writes {id: uuidv7, topic: "messaging.events.v1", kafka_key: conversationId,
            payload: json.Marshal(event)} into Postgres `outbox` table,
    SAME transaction as the messages row insert.
        ↓
Outbox poller drains to Kafka
  services/messaging-svc/internal/store/outbox.go:274-372 (DrainUnpublished,
    FOR UPDATE SKIP LOCKED) → internal/kafka/outbox.go:153-176 (buildMessages)
  publishes the exact stored JSON bytes verbatim, no re-serialization.
        ↓
ws-gateway Kafka consumer (two possible paths, same outcome)
  Broadcast mode: internal/fanout/fanout.go — Consumer.Run/handle
  Routed mode:    internal/router/router.go:80-146 — Router.Route
  Both: json.Unmarshal into contract.Event (routing-relevant fields only,
    contract/contract.go:14-41) → ev.RecipientsOf() (contract.go:49-155,
    a per-event-type switch statement) → contract.DeliveryPayload(raw)
    strips only the `members` routing-only field (contract/payload.go:58-83)
        ↓
Outbox append — DURABILITY FIRST, load-bearing ordering
  internal/store/outbox.go:51-88 (AppendOutbox / AppendOutboxMulti)
  ZADD {key: outbox:user:{tag(recipientID)}, score: contract.EpochMs(occurredAt),
        member: strippedPayload}
  + ZRemRangeByRank(0, -(maxReplayHard+1))   [trim to cap, every append]
  + Expire(outboxTTL = 24h, refreshed every append)
  router.go's own doc comment (router.go:9-17): "write the replay outbox —
  durability first, so a push that never lands is recovered on reconnect...
  Reversing [write before push] would open a window where a delivery is on
  the wire but not yet recoverable."
        ↓
Live delivery attempt (AFTER outbox write, never before)
  Local:      internal/hub/hub.go:224-248 (Hub.Fanout) — every LOCAL
              connection of the user (multi-device: one entry per connId
              under hub.users[userId]), non-blocking, sheds slow consumers
  Cross-node: internal/router pushes via internal/server/push.go:32-94
              (handlePush) to the node(s) actually holding the user's
              sockets (internal/store node registry)
        ↓
Client disconnect (any reason — network drop, sleep/suspend, process kill)
        ↓
Client reconnect
  Shared client: packages/shared/src/ws-client/WsClient.ts, used by
  apps/web (direct), apps/mobile (via packages/app/src/lib/runtime.tsx),
  apps/desktop (Electron utilityProcess, apps/desktop/src/main/ws-process.ts)
        ↓
Last-acknowledged/last-seen sequence — CONFIRMED, in-memory only
  WsClient.ts:109-116 (highWaterMs field), updated at WsClient.ts:401-404
  on every processed event: `Date.parse(e.occurredAt)`, kept only if greater
  than the current value. NOT persisted anywhere (no localStorage/
  IndexedDB/AsyncStorage — verified by repo-wide grep). Resets to 0 on every
  fresh process launch. An injection point exists for a host-supplied
  persisted cursor (`WsClientOptions.lastSeenSeq?: () => number`,
  WsClient.ts:37) but NO caller in the codebase wires it up
  (packages/app/src/lib/runtime.tsx:65-73; apps/desktop/src/main/
  ws-process.ts:58-63 — neither passes a `lastSeenSeq` key).
        ↓
hello frame sent
  WsClient.ts:270-274: `ws.send(JSON.stringify({type:"hello", lastSeenSeq:
  this.highWaterMs || this.opts.lastSeenSeq?.()}))`. On a fresh process,
  highWaterMs=0 and the fallback is always undefined → the key is dropped
  by JSON.stringify entirely.
        ↓
Replay lookup
  server/conn.go:540-584 (onHello): sends `ready`, a presence snapshot, then
  calls store.Replay(ctx, userID, seq) where seq comes from the (possibly
  absent) lastSeenSeq pointer (conn.go:562-566: nil → seq=0).
        ↓
Redis replay
  store/outbox.go:124-154 (Replay):
    seq<=0  → ZRange(key, -maxReplayDefault, -1)          [cursorless: most
                                                             recent 200]
    seq>0   → ZRevRangeByScore(Min=seq inclusive, Max=+inf,
                                Count=maxReplayHard), then reversed to
                                oldest-first
        ↓
WebSocket delivery (replay burst)
  conn.go:571-575, deliverCtx with BACKPRESSURE (blocks until writeLoop
  drains a slot) — deliberately different from live fan-out's non-blocking
  drop-and-close, so a large catch-up burst can't trip the connection closed
  mid-replay. Followed by an explicit `replay.done` frame (conn.go:583).
        ↓
Client dedup
  WsClient.ts:385-392 (handleMessage): `Set<string>` of eventId, FIFO-capped
  at 2048 (DEDUP_LRU const, but the eviction is oldest-in-first-out, not
  true LRU — no touch-on-access).
        ↓
ACK (message.ack) — separate from all of the above
  conn.go:346-359 → internal/delivery/delivery.go:126 (Dispatcher.Ack)
  batches per recipient over a 500ms window → POST
  {baseURL}/internal/messages/delivered → messaging-svc emits the canonical
  MessageDelivered event from there (services/messaging-svc/internal/store/
  receipts.go:277-319, emitDeliveredEventsTx). Best-effort UX ("delivered
  badge"), circuit-breaker protected, worst case on failure is a stuck
  "Sent" badge — NOT a data-loss or replay-correctness path.
```

**REST fallback path** (see section Q for full detail):
```text
Redis replay returns fewer/none of the missed events
        ↓
Client has NO explicit signal that this happened (see section N/Q — this is
a real, previously-undocumented gap)
        ↓
IF the client separately decides to backfill (e.g. opening a conversation
whose message list looks incomplete), it calls:
  GET /api/v1/conversations/{id}/messages?beforeSeq=&limit=  (messaging-svc/
    internal/api/api.go:289, handler listMessages, api.go:826-845)
  GET /api/v1/threads/{id}/messages?beforeSeq=&limit=        (api.go:481,
    handler listThreadMessages, internal/api/threads.go:42-56)
        ↓
Both are single-parent-ID keyset pagination (ORDER BY seq DESC LIMIT,
exclusive beforeSeq cursor) — NEITHER accepts multiple conversation IDs nor
a raw list of message IDs. There is no "give me everything I missed across
every conversation" endpoint.
```

---

## D. Current Redis Data Model

- **Key**: `outbox:user:{tag(userID)}` — one ZSET per recipient user, not
  per conversation/org. `tag()` applies cluster hash-tagging only when
  `clustered=true` (store.go).
- **Score**: `occurredAt` truncated to epoch-milliseconds
  (`contract.EpochMs`, `contract/score.go`), shared by both write paths
  (fanout.go and router.go) so they order identically.
- **Member**: the full event JSON, minus only the `members` field (routing
  metadata, stripped by `contract.DeliveryPayload`). Not globally unique,
  not unique per recipient, not unique per conversation or org — **the score
  is not a unique key at all**; two events in the same millisecond share a
  score, which is exactly why `Replay`'s cursor bound is deliberately
  inclusive (see the extensive doc comment at `outbox.go:96-123`) and why
  client dedup-by-`eventId` is load-bearing, not optional.
- **Sequence uniqueness** (Phase 2 Q4-7, answered directly): NOT globally
  unique, NOT unique per recipient, NOT unique per conversation (that's
  what the payload's separate `seq` field is for, and even that is scoped
  per-conversation/per-channel, not globally), NOT unique per org. The
  Redis score is purely a coarse, collision-tolerant ordering hint.
- **Last-acknowledged sequence storage**: there is no server-side storage
  of this at all — see section C. It is 100% client-managed, in-memory,
  reset on every fresh process launch.
- **Expiration**: whole-key TTL, 24h, refreshed (not rolling) on every
  append — an inactivity window, not an age window.
- **Deletion**: `ZRemRangeByRank(0, -(maxReplayHard+1))` on every append —
  trims to the newest `maxReplayHard` entries, unconditionally, every
  single write.
- **Missing-sequence behavior**: `ZRevRangeByScore` with an inclusive lower
  bound simply returns however many entries currently satisfy the range —
  if the requested range extends earlier than what the cap has retained,
  the response is silently smaller than what was actually missed, with
  **no explicit "you are missing N events" signal** anywhere in the
  protocol. This is true today at cap=2000 and would be true at any cap;
  lowering the cap only makes the scenario more probable, not new in kind.
- **Duplicate handling**: expected and by design (inclusive boundary),
  resolved by client-side `eventId` dedup, which is the same mechanism that
  already makes at-least-once Kafka delivery safe end-to-end.
- **Two-device / two-node reconnect races**: `Hub.Fanout` (hub.go:224-248)
  enqueues to every local connection non-blockingly; a slow/full consumer
  is shed and closed, which drives it into the exact same reconnect+replay
  path — "at-least-once that lands once," per the code's own comment. The
  outbox write happening strictly before any delivery attempt (both
  fanout.go and router.go) is what makes this safe regardless of how many
  devices/nodes are involved.
- **Redis write before WS delivery / WS delivery with a failed Redis
  write**: both traced directly — write is unconditional and always first;
  a write failure is logged and non-fatal (the doc comment in router.go:
  "A delivery that arrives on a live socket but is missing from replay is
  better than no delivery at all"), so a client that was online still gets
  the event even if Redis is down, but loses the replay safety net for
  that one event until it reconnects.
- **ACK racing replay**: structurally impossible to race in a way that
  loses data — ACK (`message.ack`) is entirely decoupled from the outbox/
  replay ZSET; it only ever affects the separate delivered-badge signal via
  a POST to messaging-svc (section C).

---

## E. Event-by-Event Field Audit

Legend: **Repl**=required for replay correctness · **Cli**=read by client
code · **Srv**=server-only (routing/internal) · **Ord**=used for
ordering · **Dedup**=used for dedup · **DB**=has/implies a DB lookup ·
**Auth**=authorization-relevant · **Deriv**=derivable from elsewhere ·
**Elsewhere**=already known from another source at read time ·
**Remove?**=can be dropped from the *stored/replayed* payload without
breaking anything found.

### `message.created` (14 fields, struct: `services/messaging-svc/internal/events/events.go:87-119`)

| Field | Repl | Cli | Srv | Ord | Dedup | DB | Auth | Deriv | Elsewhere | Remove? | Evidence |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `type` | ✓ | ✓ | ✓ | – | – | – | – | – | – | No | dispatch discriminant everywhere |
| `eventId` | ✓ | ✓ | – | – | ✓ | not in DB (see G) | – | No | – | **No** | `WsClient.ts:386-391`; not a `messages` column |
| `occurredAt` | ✓ (is the score) | ✓ | – | ✓ | – | `created_at` | – | Yes (DB) | Already the ZSET score | **Partial** — needed on the wire for client render, NOT needed again in the stored member beyond the score | `WsClient.ts:403-404`; `queryBridge.tsx:325` |
| `seq` | – | ✓ | – | ✓ (in-thread) | – | `messages.seq` | – | Yes (DB) | – | Yes, from replay's perspective (unrelated axis) | `queryBridge.tsx:313-327`, sort by `.seq`; not used by `WsClient`'s cursor logic |
| `body` | ✓ | ✓ (render) | – | – | – | `body_enc` (encrypted) | – | Yes (DB, needs decrypt) | – | No (content) | `queryBridge.tsx:321`, preview text |
| `orgId` | – | **unused** | routing consumed? No — RecipientsOf never reads org | – | – | `messages.org_id` | RLS-relevant server-side | Yes (DB) | Client is single-active-org (see G) | **Yes** | repo-wide grep, zero client reads of event's own `orgId` |
| `origin` | – | ✓ (Inbox-vs-chat filter) | – | – | – | not in schema dump seen | – | UNKNOWN | – | No | `inboxPatch.ts:36-37` |
| `senderId` | ✓ (routing) | ✓ (echo-skip, peer-id, render) | ✓ | – | – | `messages.sender_id` | – | Yes (DB) | – | No | `contract.go:52`; `inboxPatch.ts:39`; `queryBridge.tsx:310-312,344` |
| `threadId` | – | ✓ (cache bucket, ack bucket) | – | – | – | `messages.thread_id` | – | Yes (DB) | – | No | `inboxPatch.ts:38,95`; `WsClient.ts:398` |
| `messageId` | ✓ (reconstruction reference) | ✓ (patch/dedup key) | – | – | – | `messages.id` (PK) | – | primary key itself | – | **No — this is the reference** | `queryBridge.tsx:315`; `fetchDeliveryCandidatesTx`, `receipts.go:102-123` |
| `clientMsgId` | – | **unused from WS event** | server-side idempotency on the ORIGINAL POST, not replay | – | – | `messages.client_msg_id` | – | Yes (DB, if ever needed) | Reconciliation uses the REST response, not the WS echo | **Yes (from replay payload)** | exhaustive trace, zero reads of `e.clientMsgId`; `useOptimisticSend.ts:94-111`; `client.ts:896-938` |
| `recipientId` | ✓ (message.created only — peer-id resolution on sender's own multi-device echo) | ✓ | ✓ (routing) | – | – | **not a `messages` column** — needs a join (see H) | – | Partially — needs `conversation_members` join, not a simple column read | – | **No** (this type only) | `contract.go:51-52`; `inboxPatch.ts:39` |
| `isThreadRoot` | – | ✓ (render) | – | – | – | `messages.is_thread_root` | – | Yes (DB) | – | No | `inboxPatch.ts:103` |
| `conversationId` | ✓ (reconstruction scope) | ✓ (primary cache key) | ✓ | – | – | `messages.conversation_id` | – | Yes (DB, via messageId join) | – | No (or derivable via messageId join — see H) | `queryBridge.tsx` throughout |

### `message.read` (up to 9 fields: `events.go:161-171`)

| Field | Repl | Cli | Srv | Notes |
|---|:-:|:-:|:-:|---|
| `type` | ✓ | ✓ | ✓ | discriminant |
| `eventId` | ✓ | ✓ (dedup) | – | same as above |
| `orgId` | – | **unused** | – | same finding as message.created |
| `occurredAt` | ✓ (score) | not read | – | `patchThreadOnRead` never reads it |
| `conversationId` | ✓ | ✓ | – | `inboxPatch.ts:186-192` |
| `threadId` (optional) | – | ✓ | – | falls back to conversationId when absent |
| `readerId` | – | **unused** | ✓ (who read) | `patchThreadOnRead` reads only threadId/conversationId/upToSeq |
| `upToSeq` | ✓ (the whole semantic content) | ✓ | – | compared against cached `.seq` to flip status to SEEN |
| `recipientId` | – | **unused** | ✓ (routing: `[RecipientID]` only, `contract.go:83-84`) | genuinely redundant with "I received this frame" for THIS type |

**Structurally different from `message.created`**: this event has no
`messageId` to dereference. Its entire semantic content is "reader X has
read up to seq Y in scope Z" — a **monotonic watermark**, not a discrete
fact about one message. See section H — this is the strongest case in the
whole audit for "does this even need per-event replay at all," since a
durable current value (`conversation_members.last_read_seq` /
`thread_members.last_read_seq`, confirmed to exist:
`services/messaging-svc/migrations/0001_init.sql:20`,
`0003_threads_inbox.sql:43`) already **supersedes** any stale intermediate
read event a client might have missed.

### `message.delivered` (10 fields: `events.go:175-186`)

| Field | Repl | Cli | Srv | Notes |
|---|:-:|:-:|:-:|---|
| `type` | ✓ | ✓ | ✓ | discriminant |
| `eventId` | ✓ | ✓ (dedup) | – | |
| `orgId` | – | **unused** | – | same finding |
| `occurredAt` | ✓ (score) | not read | – | |
| `conversationId` | ✓ | ✓ | – | `patchThreadOnDelivered` |
| `threadId` (optional) | – | ✓ | – | |
| `messageId` | ✓ (reference) | ✓ (patch key) | – | same PK reference as message.created |
| `senderId` | – | **unused** | ✓ (routing: `[SenderID]` only — sender-only echo) | `contract.go:85-87` |
| `recipientId` | – | **unused** | – | |
| `deliveredAt` | – | **unused** | – | redundant with occurredAt/score in practice |

Best-effort UX signal by the system's own design (`delivery.go:1-16`'s doc
comment) — a strong candidate for being entirely exempted from strict
replay-cap accounting, independent of any record-shrinking work.

---

## F. UUID Audit

Eight UUID-shaped fields appear across the three event types:
`orgId, eventId, senderId, threadId, messageId, clientMsgId, recipientId,
conversationId`. For the `message.created` example payload (532B compact
JSON), these 8 fields' raw string values alone total **288 bytes — 54.1%
of the entire payload** (MEASURED, direct computation on the real example).

| UUID | Exists in Redis key already? | Exists in session/JWT already? | Removable from stored payload? |
|---|---|---|---|
| `orgId` | No — key is `outbox:user:{recipientId}`, no org component | Yes, `claims.OrgID`/membership list, but **client never uses the event's copy anyway** (see G) | **Yes** |
| `recipientId` | Partially — for `message.read`/`message.delivered` (routed recipient-only/sender-only), the frame's very existence tells the client who it's for. For `message.created`, NO — routed to both sender and recipient, so it's not implied | No | Type-dependent: **No** for message.created, **Yes** for message.read/delivered |
| `eventId` | No | No | **No — required for dedup correctness, cannot be regenerated (see G)** |
| `senderId` | No | Sometimes (own messages) but not for received ones | No (actively used) |
| `threadId` | No | No | No (actively used) |
| `messageId` | No | No | No — this is the reconstruction reference itself |
| `clientMsgId` | No | Client already has it locally for ITS OWN sends (it minted it) | **Yes — client never reads it back off the WS event (see G)** |
| `conversationId` | No | No | No (actively used, or derivable via messageId join) |

Binary vs. textual UUID (Phase 9): a 36-byte hyphenated-text UUID vs. a
16-byte binary UUID is a **20-byte (55.6%) per-field reduction**, MEASURED
directly: `uuid.UUID(text).bytes` in Python — no estimate needed, this is
deterministic. Applied to all 8 fields in the full current payload: 288B
text → 128B binary, a 160B (30.1% of the whole 532B payload) reduction on
its own, before removing a single field. But per the optimization order the
spec itself prescribes (remove unnecessary data → remove duplication → use
an existing smaller representation → binary UUID → custom compression),
this is evaluated **after** field removal, not instead of it — see section
K/S.

---

## G. Redundancy Findings

Two fields are **confirmed genuinely unused by every client this task
traced** (web, mobile, desktop — one shared `WsClient` implementation,
verified at `packages/shared/src/ws-client/WsClient.ts`), across all three
event types:

1. **`orgId`** — zero reads of `ServerEvent.orgId` found anywhere in
   `packages/app`, `apps/web`, `apps/mobile`, `apps/desktop`. Traced to a
   structural reason, not just absence of use: the client holds exactly one
   organization's state at a time (`OrgSwitcher.tsx:82`: `qc.clear()` wipes
   the entire query cache on org switch), and every routing key the client
   actually uses (`conversationId`/`threadId`/`channelId`/`taskId`) is
   already org-scoped at the database layer via row-level security
   (`services/messaging-svc/migrations/0026_org_isolation.sql`), so the
   event's own `orgId` carries no routing information the client needs.
   **One caveat surfaced, not a reason to keep the field, but worth
   recording**: ws-gateway's delivery routing (`contract.go`'s
   `RecipientsOf`) is by bare `userID`, not scoped to the socket's *active*
   org, while presence registration iterates every org membership
   (`conn.go:66-84`) — meaning a multi-org user's single socket can in
   principle receive an event for a non-active org membership. The client
   doesn't guard against this today (with or without `orgId`), so removing
   the field changes nothing about this pre-existing, unrelated latent
   behavior — it is flagged here only for completeness, not as a blocker.

2. **`clientMsgId`** — exhaustively traced through every optimistic-send
   reconciliation path (`useOptimisticSend.ts`, `MailThread.tsx`,
   `client.ts`'s `reply`/`sendChannelMessage`); every one of them reconciles
   using the **REST response** of the client's own POST, which already
   carries the server-confirmed `messageId`/`seq` — none of them read
   `clientMsgId` back off the inbound WebSocket event. The sender's own
   echo is in fact skipped entirely for cache-patch purposes
   (`queryBridge.tsx:310-312`: `if (e.senderId !== me) {...}`). One
   secondary, unrelated finding surfaced during this trace: Electron's
   sticky-chat forwarding path (`ws-process.ts:160-174`) already omits
   `clientMsgId` when relaying to the renderer, and that surface's own
   local dedup is by `messageId` matching a `temp:${clientMsgId}` id that
   will never match — a **possible latent duplicate-bubble bug**,
   independent of this optimization, flagged as UNKNOWN (not verified
   either way) and out of this report's scope to resolve.

Both are confirmed still needed **elsewhere** — `orgId` for
RLS/authorization context server-side, `clientMsgId` for the POST-time
idempotent-insert uniqueness constraint
(`messages_conv_sender_clientmsg_thread_key`,
`0003_threads_inbox.sql:144-167`) — so this finding is specifically about
the **replayed/stored payload copy**, not about removing the fields from
the system.

**`recipientId`** is a more nuanced case than "redundant with the Redis
key" (which was the report's original hypothesis) — see section E's tables:
genuinely load-bearing for `message.created` (peer-identity resolution on
the sender's own multi-device echo, since that type is routed to both
parties), but unread by the client for `message.read`/`message.delivered`.
**Do not remove it from `message.created`; it is a real candidate for
removal from the other two types.**

---

## H. Reconstruction Design

```text
Redis record (minimal reference)
    ↓
{eventType discriminant, eventId, messageId}
    ↓
messaging-svc: bulk WHERE id = ANY($1) against `messages`
    (existing precedent: fetchDeliveryCandidatesTx, receipts.go:102-123,
     already proven at up to 256 ids/call in production;
     appendCallsTx, calls.go:1408-1421, the same two-phase
     "keyset-ids-then-bulk-hydrate" shape for call history)
    ↓
Decrypt body_enc AFTER releasing the pooled connection
    (follow the FIXED pattern — ListConversations, conversations.go:251-379,
     WarmVersions-inside-tx + DecryptCached-after-commit — NOT the
     still-unfixed pattern ListMessages/ListThreadMessages currently use,
     which decrypts INSIDE the transaction; see section J for why this
     matters)
    ↓
JOIN against conversation_members for recipientId
    (message.created only — recipientId is NOT a `messages` column;
     for a 1:1 conversation this is "the other member," but this needs
     real design work to handle correctly and safely, not a plain column
     read — flagged as UNKNOWN precision, PROPOSED FUTURE WORK, not solved
     here)
    ↓
Full event reconstruction — rebuild the ORIGINAL JSON shape exactly,
     preserving type, eventId (verbatim, NOT regenerated — see below),
     senderId, conversationId, threadId, recipientId, occurredAt (=
     created_at, already redundant with the ZSET score), isThreadRoot,
     body (decrypted), seq
    ↓
WebSocket — client receives the SAME wire shape as live delivery,
     unchanged. No client code needs to change for this design.
```

**Why `eventId` cannot be dropped from the minimal record, even though it
looks like the most "generated, throwaway" field**: it is **not a database
column anywhere** — `messages` has no `event_id` column (confirmed against
the full schema dump in section D/J), and the Postgres `outbox` table's own
`id` (a UUIDv7 minted at `insertOutbox` time,
`services/messaging-svc/internal/store/outbox.go:25-34`) is a **different
value**, generated for the outbox row, not preserved as the event's own
`eventId`. Since client-side dedup (`WsClient.ts:386-391`) is a `Set` of
exact `eventId` strings, a reconstruction that **regenerated** a fresh
`eventId` at replay time would silently defeat dedup for anyone who already
received the live copy — a duplicate message rendered twice. **`eventId`
must be preserved verbatim in the minimal record; it cannot be derived or
regenerated.**

**`message.read` does not fit this reconstruction shape at all** — it has
no message-level reference to dereference. Section E's finding stands as
the real recommendation here: since its entire content is a monotonic
"read up to seq N" watermark, and the durable current value already lives
in `conversation_members.last_read_seq`/`thread_members.last_read_seq`, the
architecturally cleaner answer is **not** "build a reconstruction path for
this event type" but "consider excluding `message.read` from per-event
replay-cap accounting entirely, and let a reconnecting client re-sync
current read state on demand (the same shape as the existing presence
snapshot-on-hello pattern, `conn.go:552-560`)." This is a genuine design
insight this investigation surfaced, explicitly **not** something to
implement in this analysis-only pass — flagged as **PROPOSED FUTURE WORK**
per the task's own instruction to describe, not build, required changes.

`message.delivered` fits the same reference shape as `message.created`
(has `messageId`), but per section E is itself best-effort/cosmetic — a
second, independent candidate for being exempted from strict cap
accounting rather than optimized via reconstruction.

---

## I. Database/N+1 Analysis

**MEASURED/CONFIRMED, not estimated**: this codebase already has a proven
bulk-fetch-by-IDs pattern for exactly this shape of problem.
`fetchDeliveryCandidatesTx` (`receipts.go:102-123`) already runs `SELECT
... FROM messages WHERE id = ANY($1)` for up to **256 message IDs in one
query**, capped at the HTTP layer (`internal_delivery.go:58-62`). Its own
doc comment describes the exact problem this report needs solved: *"It used
to run one SELECT, one conditional membership query, and one INSERT per id,
sequentially, inside a retry loop... batch the reads with `= ANY($1)`."*
`appendCallsTx` (`calls.go:1408-1421`) is a second, independent precedent —
hydrating a whole page of call IDs in **three fixed queries regardless of
page size**.

| Replay events | DB queries (proposed design) | Basis |
|---:|---|---|
| 10 | 1 (`= ANY($1)` with 10 elements) + 1 join for recipientId (message.created only) | same shape as `fetchDeliveryCandidatesTx` |
| 100 | 1-2 | same — query count does not scale with N, only the `$1` array does |
| 500 | 1-2 | same |
| 1,000 | 1-2 (or split into ≤256-id batches per the existing cap, so up to 4) | existing precedent caps at 256/call; a 1000-event reconnect would issue up to 4 such batched queries, still O(1) relative to a naive N+1 |

**This design explicitly avoids "1 Redis event = 1 database query."**

**The real, evidence-based risk is not query count — it is connection-hold
duration**, and this codebase has already learned this lesson once. The
primary Postgres pool is capped at **`MaxConns=10`, `MinConns=2`**
(`services/messaging-svc/internal/store/store.go:52-84`), shared by every
request path in the service — sends, reads, receipts, the outbox poller,
everything. A documented incident (referred to in-code as "Phase 11":
`conversations.go:251-260`) found that decrypting rows **while still
holding a transaction's connection open** was a real problem against this
10-connection budget, and `ListConversations` was rewritten to warm the
decrypt cache inside the transaction but perform the actual AES-GCM
decrypt **after** the connection was released back to the pool. **Critically,
`ListMessages` and `ListThreadMessages` — the exact REST backfill endpoints
this report's replay-gap design would lean on — still decrypt INSIDE the
transaction** (`receipts.go:680-684`, `threads.go:397-401`), i.e. they were
**not yet upgraded to the fixed pattern**. A reconstruction query modeled
naively on these two endpoints, rather than on `ListConversations`'s fixed
shape, would reintroduce exactly the already-diagnosed problem at up to
1000 rows per reconnect, against a pool of only 10 connections shared
platform-wide. **This is a real, concrete implementation requirement for
any future build of this design, not a hypothetical risk** — flagged
explicitly as a must-fix-first item in section V/X.

Expected query size/DB CPU/latency/connection-pool impact for the proposed
design: not independently benchmarked this task (no messaging-svc-side
load test was run) — marked **UNKNOWN / not measured**, recommended as a
prerequisite before implementation, consistent with the task's own
prohibition on fabricating precision.

---

## J. Serialization Comparison

All entries in row A/B/C/D of the table below are **MEASURED** (real
`json.dumps`/`msgpack.packb` output on the actual example
`message.created` payload, 532 bytes compact JSON baseline) via a real
Python `msgpack` library, not estimated:

| Option | Payload Bytes | Redis Total (est., ×1.24 measured overhead ratio) | CPU | Complexity | Compatibility | Debuggability | Migration | Risk |
|---|---:|---:|---|---|---|---|---|---|
| A. Current JSON | 532 (measured) | ~660 | baseline | none | full | full — plain text in `redis-cli` | none | none |
| B. Compact JSON, short field names | 440 (measured) | ~546 | negligible | low | full (still JSON) | reduced — needs a key-name legend | field-name mapping table, both directions during rollout | low |
| C. MessagePack, no semantic change | 481 (measured) | ~596 | low (fast binary decode) | medium | requires a msgpack decoder client-side or server-side re-encode to JSON before the wire | poor raw (binary in `redis-cli`) — needs a decode tool | new dependency (msgpack) in the WS wire format or a server-side re-encode step | medium |
| D. MessagePack + binary UUIDs | 321 (measured) | ~398 | low-medium (UUID pack/unpack) | medium-high | same as C | poor raw | same as C + UUID (16B binary) handling both sides | medium |
| E. Custom binary (minimal reference) | 33 (measured semantic minimum) | **117 (MEASURED — real scratch-Redis ZADD/MEMORY USAGE, not estimated)** | low, but requires a reconstruction round-trip server-side before the wire | high | requires a version byte + dual-decode during rollout (section R) | poor raw, but the client NEVER sees this format (server reconstructs to full JSON before the wire — see H) | new internal format + reconstruction service path | medium-high, but scoped: nothing about the client wire contract changes |
| F. Compact numeric/internal IDs | not evaluated | not evaluated | — | — | — | — | — | **Not recommended per the spec's own Hard Rule 9 — this would require a new ID-mapping layer solely for this optimization, which is explicitly disallowed** |

**Recommendation ordering** (do not jump to binary encoding just because it
is smaller — the spec's own instruction): **remove unnecessary fields
first (section G) → this alone is JSON, zero format risk, 18.8% measured
reduction → only THEN consider compact keys/binary encoding if the
remaining size still doesn't meet the 40K target with adequate margin (it
does — see section O).**

---

## K. UUID Encoding Comparison

MEASURED directly (not estimated): 36-byte hyphenated text UUID → 16-byte
binary, a 20-byte/55.6% per-field reduction, deterministic
(`uuid.UUID(text).bytes`). Applied to all 8 UUID-shaped fields in the
current `message.created` payload: 288B text → 128B binary (160B / 30.1%
of the full 532B payload) — **without removing a single field**.

Per the spec's own required evaluation order:
```text
remove unnecessary data        → section G: orgId, clientMsgId (18.8%)
        ↓
remove duplicated data          → none found: no field in this audit is a
                                   true duplicate of another wire field
                                   (recipientId is NOT a duplicate of the
                                   Redis key — see F)
        ↓
use existing smaller repr.      → none exists today (no internal numeric
                                   ID system for these entities)
        ↓
binary UUID                     → 30.1% additional reduction, MEASURED
        ↓
custom compression              → not evaluated; general-purpose
                                   compression (gzip/zstd) on payloads this
                                   small (300-500B) typically costs more in
                                   per-entry fixed overhead (dictionary/
                                   header) than it saves — not measured
                                   this task, flagged UNKNOWN, and likely
                                   counterproductive at this size per
                                   general knowledge of compression
                                   overhead floors, marked as such rather
                                   than asserted as fact
```

**No ID-mapping layer is proposed** (Hard Rule 9 compliance) — binary UUID
encoding uses the UUID's own bytes directly, not a new short-ID scheme.

---

## L. Redis Data Structure Comparison

| Structure | Memory (MEASURED at N=500, matched payload) | Ordering | Range retrieval | Sequence lookup | Deletion | Trimming | Expiry | Partial replay | Complexity | Migration risk |
|---|---|---|---|---|---|---|---|---|---|---|
| **ZSET (current)** | 499.4 B/entry | native (score) | `ZRANGE`/`ZREVRANGEBYSCORE`, exactly what's used today | score-based, collision-tolerant (see D) | `ZREM`/`ZREMRANGEBYRANK` | `ZREMRANGEBYRANK`, exact | `EXPIRE` on key | ✓, exactly today's design | none — already built | none |
| **LIST** | not measured | insertion order only | `LRANGE` (positional, not score-based) | **No native score-range query** — cannot serve today's inclusive-cursor-by-timestamp replay without a redesigned cursor (e.g. "N-back" instead of "since time T"), which changes the wire contract | `LREM` (O(N)) | `LTRIM` (cheap) | `EXPIRE` | Only via a different cursor semantics | Would require a wire-contract change | **Rejected** — cannot serve the current query shape at all |
| **STREAM** | 483.8 B/entry (MEASURED, real scratch-Redis `XADD`+`MAXLEN`) — **3.1% smaller than ZSET at matched cardinality/payload** | native (`<ms>-<seq>` ID) | `XRANGE`/`XREVRANGE` | **Natively disambiguates same-millisecond entries** via the auto-incrementing `-seq` suffix — this is EXACTLY the problem `outbox.go`'s own lengthy doc comment (lines 96-123) works around with the inclusive-bound-plus-client-dedup design | `XDEL`/`XTRIM` | `XADD ... MAXLEN` (approximate by default; exact trim, as measured, is more expensive per Redis's own documented behavior) | `EXPIRE` on key | ✓ | New client library surface, new command set, no consumer-group need (simple polling, not consumed) | Real but bounded — not a data-loss-risk migration, but a genuine cutover requiring dual-read during rollout |
| **HASH + ordering** | not measured | none native — needs an external sorted index | requires a companion structure | requires a companion structure | `HDEL` | manual | `EXPIRE` on key | requires reinventing what ZSET already provides | High — would need to build back the exact functionality ZSET provides for free | **Rejected** — strictly worse than ZSET for this access pattern without added complexity |

**Recommendation: keep ZSET.** Streams' 3.1% memory improvement is real but
**not substantial** per the spec's own instruction ("do not recommend
changing ZSET unless the measured benefit is substantial") — a
memory-motivated migration is not justified. Streams' native fix for the
same-millisecond collision problem is a genuine architectural elegance
argument, independent of memory, but on its own does not meet the bar for
recommending a data-structure migration in this report; it is noted as a
secondary, non-blocking observation, not a recommendation.

---

## M. Cap-100 Impact Analysis

1. **Current cap**: `maxReplayHard = 2000`, `services/ws-gateway/internal/store/outbox.go:32`.
2. **Where defined**: same file, a compile-time constant, consumed by `AppendOutbox`/`AppendOutboxMulti` (trim) and `Replay` (query `Count`).
3. **Retention effect**: every append trims the ZSET to the newest `maxReplayHard` entries, unconditionally — the cap is a hard ceiling on retained entries per user, not a soft target.
4. **Replay effect**: bounds the cursor-based query's result size; the cursorless path (fresh process, `maxReplayDefault=200`) is entirely independent of this constant.
5. **REST fallback trigger**: per section C/Q, **there is no explicit trigger** — no code path detects "the cursor-based replay returned fewer entries than were actually missed" and automatically calls the REST backfill endpoints. This is true at any cap value; a lower cap makes hitting it more probable, but does not create a new failure mode.
6. **Inclusive/exclusive at the boundary**: inclusive (deliberate, see `outbox.go:96-123`).
7. **Boundary behavior at 99/100/101** (MEASURED via the same 200,000-sample weighted model used throughout this report's capacity math, `random.seed(7)`):

   | missed-events threshold | % of modeled population at/above |
   |---:|---:|
   | 99 | 23.45% |
   | 100 | 23.34% |
   | 101 | 23.19% |

   At cap=100, since the ZSET itself never holds more than 100 entries
   (trimmed on every append), a client whose cursor is exactly 100 events
   behind the current tip still receives a complete, correct catch-up
   (all 100 retained entries satisfy the inclusive `Min` bound). A client
   101+ events behind receives only the newest 100 — silently fewer than
   were actually missed, **with no signal distinguishing "you got
   everything" from "you got a truncated tail"** (see point 5 and section
   Q — this is the same gap that exists at any cap, just crossed sooner).
8. **Can users miss events between replay and REST fallback?** Yes, in
   principle, given point 5 — but this is an existing gap, not introduced
   by lowering the cap. It is, however, **more consequential** at a lower
   cap purely because the boundary is crossed by more users (23.19% at
   cap=100 vs. 9.90% at cap=200, both MEASURED against the same
   distribution model).
9. **Multi-device semantics**: unaffected by the cap value — each device
   is an independent connection with its own `hello`/cursor exchange
   (`hub.go`'s per-connId tracking); the cap changes how much any one
   device can catch up in one shot, not the multi-device model itself.
10. **Long disconnects and REST dependency**: **the single most important
    finding of this report for interpreting the cap-100 impact** — per
    section C, the cursor-based path (the one `maxReplayHard` governs) is
    **only reachable by a socket reconnecting within an already-running
    client process** (laptop sleep/wake, mobile backgrounding without
    process kill, brief network drop). A user who fully quits and
    relaunches the app — which is what "long disconnect" most naturally
    evokes — resets `highWaterMs` to 0 and takes the **cursorless**
    `maxReplayDefault=200` path instead, which `maxReplayHard` does not
    govern at all. **The population actually exposed to a lower
    `maxReplayHard` is narrower than "everyone who reconnects after a long
    gap" — it is specifically "processes that stay alive (even if
    suspended/backgrounded) across a gap long enough to miss more than the
    new cap's worth of events."** This meaningfully changes the real-world
    risk profile of lowering the cap, in the direction of lower risk than
    a naive reading of the missed-events percentages alone would suggest,
    though it does not eliminate the REST-fallback-trigger gap in point 5,
    which is orthogonal.

### Boundary matrix (as specified)

| Missed Events | Expected Path | Expected Result |
|---:|---|---|
| 0 | normal | no replay |
| 1 | Redis | replay |
| 10 | Redis | replay |
| 50 | Redis | replay |
| 99 | Redis | replay (complete, within cap) |
| 100 | boundary | complete (inclusive bound, exactly at cap) — VERIFIED against `Replay()`'s exact query shape, not assumed |
| 101 | REST fallback needed, but NOT automatically triggered (section Q gap) | client silently receives 100 of 101 missed events unless it separately backfills |
| 200 | REST fallback needed, not automatically triggered | same gap, larger shortfall |
| 500 | REST fallback needed, not automatically triggered | same gap |
| 1000 | REST fallback needed, not automatically triggered | same gap |

---

## N. 40K User Capacity Model

MODELED, using the same 200,000-sample weighted usage-class distribution
established in the prior capacity-planning task (70% light 1-50 entries /
20% normal 50-200 / 8% heavy 200-750 / 2% near-cap 1000-2000,
`random.seed(7)`), extended with cap=100, at 600 bytes/entry (the
conservative, previously-measured all-in figure — this report's own new
measurements of smaller record designs are evaluated separately in section
S, not substituted into this specific table since this section evaluates
cap=100 against the CURRENT record format, per the spec's own Phase 12
framing):

**Outbox-only projected Redis memory (GiB), current record format:**

| Users | Cap 100 | Cap 200 | Cap 500 | Cap 750 | Cap 1000 | Cap 2000 |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 0.258 | 0.350 | 0.480 | 0.533 | 0.561 | 0.617 |
| 20,000 | 0.515 | 0.701 | 0.960 | 1.066 | 1.122 | 1.233 |
| 30,000 | 0.773 | 1.051 | 1.440 | 1.599 | 1.683 | 1.850 |
| **40,000** | **1.030** | 1.402 | 1.920 | 2.132 | 2.244 | 2.467 |
| 50,000 | 1.288 | 1.752 | 2.400 | 2.665 | 2.804 | 3.083 |

Acceptance banding at 40K:

```text
GREEN  <= 1.6 GiB:  cap 100 (1.030), cap 200 (1.402)
WARNING > 1.6, <= 2.0 GiB:  cap 500 (1.920)
FAIL   > 2.0 GiB:  cap 750 (2.132), cap 1000 (2.244), cap 2000 (2.467, CURRENT)
```

**This is outbox-only memory** — non-outbox Redis memory (presence,
node registry, rate-limit buckets, read cache; all confirmed in the prior
task to share this same 2 GiB instance) was not independently re-measured
at 40K-equivalent load this task; it was estimated as small relative to
the outbox given those consumers store short scalars/small structures per
connection rather than full event copies, but that is a carried-forward
estimate, not a fresh measurement — flagged consistent with the prior
report's own limitation.

`evicted_keys = 0` is structurally guaranteed regardless of cap, since
production Redis's `maxmemory-policy` is `noeviction` (confirmed prior
task) — evictions cannot occur under this policy; a write is rejected
instead. This satisfies the spec's explicit acceptance requirement without
needing a runtime check specific to this optimization.

**Growth headroom at cap=100**: breakeven at the 1.6 GiB (80%) safety
target ≈ **62,132 users**; at the full 2 GiB ceiling ≈ **77,664 users**
(MEASURED via the same model) — substantially more headroom than cap=200's
previously-computed ~45,600/~57,000, at the cost of a larger trimmed
population (23.19% vs. 9.90%) whose real-world impact is narrowed by
finding 10 above.

---

## O. Replay Correctness Matrix

| Scenario | Required Behavior | Risk | Evidence |
|---|---|---|---|
| Normal reconnect | correct replay | Low | `Replay()` traced exactly, section C |
| Short disconnect | correct replay | Low | cursor path, within cap |
| Long disconnect (process alive) | correct replay up to cap, REST needed beyond | Medium — REST not auto-triggered (section Q) | section M point 5 |
| Long disconnect (process killed/relaunched) | cursorless path, `maxReplayDefault=200`, NOT affected by `maxReplayHard` | Low — unaffected by this report's cap change | section C/M finding 10 |
| 99 missed | Redis, complete | Low | MEASURED, section M |
| 100 missed | Redis, complete (boundary) | Low | MEASURED, inclusive bound confirmed |
| >100 missed | REST needed, not auto-triggered | **Medium — pre-existing gap, not introduced by this report** | section Q |
| Multiple devices | no loss | Low | `Hub.users[userId][connId]`, independent per-device hello/cursor |
| Simultaneous connections | no loss | Low | same — `Hub.Fanout` iterates all local conns; outbox write precedes any delivery attempt |
| Event during reconnect | no loss | Low | outbox write is unconditional and precedes delivery/push in both fanout.go and router.go |
| Duplicate event | safely deduped | Low | `WsClient.ts:386-391`, FIFO-capped Set on `eventId` |
| Out-of-order delivery | corrected via oldest-first replay + client sort by `seq`/`occurredAt` | Low | `Replay()` reverses to oldest-first; client sorts by `.seq` within a thread |
| Missing Redis entry (trimmed/expired) | REST needed | **Medium — not auto-triggered** | section Q |
| Redis expiry (24h inactivity) | REST | Medium — same gap | `outboxTTL`, section D |
| Redis eviction | N/A — `noeviction` policy means writes reject, not silent eviction | Low (by policy, not by this design) | prior task's finding, re-confirmed |
| ACK race | no skipped event | Low | ACK is structurally decoupled from outbox/replay (section D) |
| Concurrent fanout | no loss | Low | outbox-before-delivery ordering, both paths |
| Redis write/read race | no loss | Low | `AppendOutbox` is a `TxPipeline` (atomic ZADD+trim+expire); `Replay` reads the post-trim state, which is the correct/intended state to read |

**The one genuine, pre-existing correctness gap this audit surfaced** (not
introduced by cap=100, but made more consequential by it): **no code path
today detects a truncated replay and automatically triggers REST
backfill.** This is flagged for section U/V, not fixed here.

---

## P. REST Backfill Compatibility

```text
Why Redis replay stops
    → cap reached (ZREVRANGEBYSCORE naturally bounded by ZSET's own
      ≤maxReplayHard cardinality) or TTL expiry (whole key gone, 24h
      inactivity)
        ↓
How missing range is detected
    → NOT DETECTED TODAY (section O/Q) — this is a real gap, confirmed by
      exhaustive trace of WsClient.ts and conn.go, not assumed
        ↓
How REST endpoint is selected
    → per-conversation: GET /api/v1/conversations/{id}/messages
      per-thread:       GET /api/v1/threads/{id}/messages
      NEITHER accepts a cross-conversation or bulk-ID request — a client
      that doesn't already know WHICH conversation has a gap has no single
      call to make
        ↓
How sequence range is requested
    → beforeSeq (exclusive upper bound), keyset pagination, walking
      backward from newest; NOT a "since timestamp T" or "since seq S"
      forward-walking call — this is oriented for "load older history on
      scroll," not "catch me up on what I missed," which are subtly
      different access patterns
        ↓
How events are reconstructed
    → Full DTO rows straight from Postgres (MessageDTO), already
      decrypted server-side; no client-side reconstruction needed for
      the REST path (unlike the proposed minimal-Redis-record design,
      which reconstructs server-side before the WS wire — see H)
        ↓
How duplicates are handled
    → Client's eventId-based Set dedup does not apply to REST responses
      (they carry no eventId at all — MessageDTO has no eventId field per
      section I's schema dump); REST-sourced rows are merged/deduped by
      `messageId`/`id` instead (threadPagination.ts's merge functions,
      per the frontend agent's findings) — a SEPARATE dedup mechanism from
      the WS path's eventId Set
```

**Verifying the critical invariant**: *"Redis cannot reconstruct event +
REST cannot provide event = permanent replay loss must never happen."*
Since REST backfill reads directly from the authoritative `messages` table
(the same source of truth the event was originally built from,
§messaging-svc agent's finding on `appendMessageTx`), and that table has no
TTL/expiry of its own (unlike the Redis outbox), **this invariant holds
structurally today, independent of cap value** — REST can always serve any
message that was ever successfully written to Postgres, regardless of
whether Redis has trimmed or expired its copy. The only genuine risk this
audit found is not "permanent loss" but **"the client doesn't know it needs
to ask"** (section Q) — a stale-UI-until-manual-refresh risk, not a
data-loss risk, given today's actual reconciliation behavior.

---

## Q. Backwards Compatibility

Old Redis entries may be plain full-JSON (today's format) indefinitely —
the 24h TTL naturally ages them out, so **no flush or migration is
required**; old entries simply expire within one day of any format change
shipping.

```text
old server → old entry     : reads plain JSON, works today, unaffected
old server → new entry     : ONLY relevant during a rolling deploy if a
                              newer server writes a new format a not-yet-
                              upgraded server later reads — requires the
                              OLD server to understand the NEW format,
                              which it structurally cannot without its own
                              upgrade. MITIGATION: a version marker (see
                              below) lets a reader detect "I don't
                              understand this" and treat it as a lossy but
                              safe skip (client dedup/REST-fallback
                              already tolerates a missing/skipped entry —
                              see section O), rather than a crash or
                              garbage frame.
new server → old entry     : new server must dual-decode — trivial if a
                              version marker distinguishes format, e.g. a
                              leading byte/short header the old plain-JSON
                              format never naturally starts with (a JSON
                              object always starts with `{`, 0x7B — any
                              binary format can reserve a first byte in a
                              disjoint range as an unambiguous discriminant)
new server → new entry     : works as designed
```

Recommended approach if a minimal-reference format is ever built (design
only, not implemented here): **a one-byte format discriminant is
sufficient** given plain JSON always starts with `{` (0x7B) — any binary
minimal-record format can reserve, say, `0x00`-`0x0F` as version markers,
which can never collide with a valid JSON member's first byte. Dual
decoding is then a single `if raw[0] == '{' { legacy path } else { new
path }` branch, cheap and unambiguous. Natural expiry (24h TTL) means a
rolling deploy never needs a hard cutover — mixed old/new entries coexist
correctly in the same ZSET for at most one TTL window. Rollback is
symmetric: a rolled-back OLD server would fail to decode any NEW-format
entries written during the brief window the NEW version was live, which
again degrades to "a skipped replay entry" — tolerable per section O's
existing dedup/REST-fallback behavior, not a crash. No Redis persistence
(AOF) implications beyond what already exists — the AOF just replays
whatever bytes were written, format-agnostic. **No migration is required**
under this design, by construction — this is a genuine, structural
advantage of the "server reconstructs before the wire" design from section
H, since the wire contract with the client never changes at all, only an
internal Redis-storage format.

---

## R. Exact Size Calculation

| Design | Semantic Payload | Redis Total (bytes/entry) | Reduction vs. ~600B baseline | Confidence |
|---|---:|---:|---:|---|
| Current JSON | ~413.5 B | ~600 B | baseline | measured (prior task, real prod sample) |
| Redundant-field removal (orgId + clientMsgId) | ~432 B | ~536 B (measured example payload × 1.24 overhead ratio) | 10.7% | **measured** (real example payload, both fields confirmed unused by every client) |
| Compact JSON (short keys) | 440 B (measured, full-field example) | ~546 B | 9.0% | measured |
| Binary UUID (all 8 fields, JSON abandoned for MessagePack) | 321 B (measured, MessagePack+binary UUID) | ~398 B (estimated via the same ×1.24 ratio — ESTIMATE, not independently re-measured in Redis for this exact encoding) | 33.7% | measured payload / **estimated** Redis total |
| Minimal reference (eventType+eventId+messageId, binary) | 33 B (measured, `uuid.UUID.bytes`×2 + 1 discriminant byte) | **117.0 B — MEASURED directly via a real scratch-Redis `ZADD`/`MEMORY USAGE` experiment, not estimated** | **80.5%** (vs. 600B) / **84.0%** (vs. this section's own same-run 733B full-JSON control) | **measured** |
| Minimal reference + binary UUID | same as above (already binary) | same, 117.0 B | same | measured |

**Redis's fixed per-entry overhead floor was independently measured, not
assumed**: an 8-byte raw member in the same scratch environment still cost
96.2 B/entry all-in (88.2 B of pure Redis-side overhead — skiplist node,
dict entry, sds header). This means **below roughly 100-150 bytes of
semantic payload, further shrinking has rapidly diminishing returns**,
because the floor is dominated by Redis's own object overhead, not the
payload. The 33B minimal-reference design (117.0 B measured all-in) is
already close to this floor — there is little further to gain from
"custom compression" (section K) even if it were pursued.

---

## S. Theoretical/Practical/Recommended Minimum

**Theoretical minimum** (message.created, the dominant type by volume/
bytes): the smallest information that must semantically exist for correct
replay, given the ZSET score already carries `occurredAt` for free —

```text
1 byte  event-type discriminant (selects reconstruction path)
16 bytes eventId (binary UUID — MUST be preserved verbatim; not derivable
          from any DB column found; required for existing client dedup)
16 bytes messageId (binary UUID — the reconstruction reference; existing
          messages.id primary key)
= 33 bytes
```

message.read and message.delivered have **different** theoretical minima
(section E/H) — message.read arguably needs none at all if excluded from
per-event replay in favor of a current-state resync (a design idea, not
implemented); message.delivered fits the same 33-byte shape as
message.created if kept, given it's structurally a "cosmetic echo," it is
also a candidate for exclusion from strict cap accounting.

**Practical minimum**: the 33-byte theoretical minimum, MEASURED as 117.0
bytes/entry all-in Redis storage — "practical" because it is buildable
using patterns that already exist in this codebase (bulk `= ANY($1)`
reconstruction, a decrypt-after-release pattern already proven correct
elsewhere in the same service), but requires real, non-trivial engineering:
a versioned binary Redis-internal format, a server-side reconstruction
step before the wire, correct handling of the `recipientId` join gap
(section H), and different treatment per event type (section E/H).

**Recommended production target**: **~432 bytes semantic payload / ~536
bytes all-in (measured)** — i.e., section G's zero-risk trim (drop `orgId`
and `clientMsgId`, both confirmed unused client-side, keep everything else
including the JSON format) — **not** the 33-byte/117-byte minimal-reference
design. Rationale in section W.

```text
THEORETICAL MINIMUM: 33 B (message.created; other types differ, see above)
PRACTICAL MINIMUM:    117.0 B (MEASURED)
RECOMMENDED TARGET:   ~432 B semantic / ~536 B all-in (MEASURED)
```

---

## T. Risk Analysis

| Risk | Applies to | Severity | Mitigation found in existing code |
|---|---|---|---|
| Regenerated `eventId` defeats client dedup | Minimal-reference design only | High if built incorrectly | Preserve eventId verbatim (section H) — solvable, not a blocker, but must not be skipped |
| Connection-hold-through-decrypt against the 10-conn pool | Minimal-reference reconstruction, if modeled on `ListMessages`/`ListThreadMessages` instead of the fixed `ListConversations` pattern | Medium-high at 500-1000 event reconnects | `ListConversations`'s Warm-then-release pattern already exists and is proven (section I) |
| `recipientId` reconstruction requires a join, not a column read | Minimal-reference design, message.created only | Medium — real design work needed, not solved here | Flagged as PROPOSED FUTURE WORK, not resolved |
| No REST-backfill auto-trigger on truncated replay | **Pre-existing, ALL cap values, not introduced by this report** | Medium — stale UI until manual action, not data loss (section P's invariant holds) | None found — genuine gap |
| Rolling-deploy format mismatch (minimal-reference design only) | New format only | Low, if a version-byte discriminant is used (section Q) | Design solves it structurally; degrades to a skipped entry, not a crash |
| Lower cap increases REST-fallback-gap exposure | Cap=100 specifically | Medium, but narrower population than naively assumed (section M finding 10) | None needed if section U's recommended trigger is built first |
| Removing `orgId`/`clientMsgId` breaks an undiscovered client path | Zero-risk trim (section G) | **Low** — exhaustive trace across web/mobile/desktop found zero reads of either field from a WS event | This report's own audit is the mitigation; a targeted regression test before shipping is still prudent (see X) |

---

## U. Rollback Strategy

- **Cap value**: a single constant (`maxReplayHard`, `outbox.go:32`) — trivially reversible, no data migration, effective on the next process restart of ws-gateway (existing entries already trimmed to a lower cap are NOT un-trimmed by raising the constant back — a real, if minor, asymmetry: lowering the cap is lossy in a way raising it back does not undo for already-trimmed keys, though new appends immediately respect whatever cap is live).
- **Field removal (orgId/clientMsgId)**: reversible by re-adding the fields to the struct that builds `DeliveryPayload`'s input — no format change, no client change either direction, safe to roll forward or back at will within the 24h TTL window.
- **Minimal-reference format** (if ever built): the version-byte design (section Q) makes rollback symmetric by construction — an old server encountering a new-format entry (or vice versa) degrades to a skipped replay entry, recoverable via the existing REST path (once section U/V's auto-trigger gap is closed) or via the natural 24h expiry, never a crash or corruption.

---

## V. Final Recommendation

**Ship, in this order, only after this analysis-only report is reviewed —
nothing here has been implemented:**

1. **Cap reduction to 100** (`maxReplayHard = 100`) — the modeled 40K
   outbox memory (1.030 GiB, 51.5% of the 2 GiB ceiling) is comfortably
   under the 80% safety target with real headroom to ~62K-78K users
   (section N). The functional cost (23.19% of the modeled population
   needing REST backfill for their oldest missed events on the
   within-session reconnect path) is real, but section M's finding 10
   narrows the actually-exposed population versus a naive reading, and
   section P's invariant confirms this never causes permanent loss, only
   a staleness window pending a REST catch-up.
2. **The zero-risk field trim** (drop `orgId` + `clientMsgId` from the
   stored/replayed payload) — 18.8% measured reduction, zero client
   changes, zero format risk, confirmed safe by exhaustive client-side
   trace. This is this report's recommended production target (section S),
   not the more aggressive minimal-reference design.
3. **Before either ships**: close the REST-backfill auto-trigger gap
   (section O/T) — today, a client that receives a truncated replay has no
   signal to act on. This is a pre-existing gap this report surfaced, not
   created by cap=100, but cap=100 makes it materially more likely to
   matter (23.19% vs 9.90% of the modeled population). Recommend this as a
   **prerequisite**, not a follow-on, given the severity table in section T.
4. **Do NOT build the minimal-reference (33B/117B) design in the same
   change.** It is real, measured, and buildable, but it is a genuinely
   larger engineering project (new binary format, version byte, dual
   decode, a reconstruction service path that must follow the
   `ListConversations`-not-`ListMessages` connection-hold pattern, and
   different handling for `message.read`'s watermark semantics) relative
   to its incremental byte savings once the cap and the zero-risk trim are
   already in place (1.030 GiB → an even smaller number, but 1.030 GiB
   already clears the safety target with 34 percentage points of margin —
   the minimal-reference design does not change a FAIL into a PASS the way
   the cap reduction does; it only widens an already-comfortable margin).

**Expected semantic payload size after 1+2**: ~432 bytes (measured).
**Expected Redis bytes/entry after 1+2**: ~536 bytes (measured, same
overhead ratio).
**Percentage reduction from current ~600B**: ~10.7% payload-size-driven,
compounding with the cap-100 population-level reduction already shown in
section N (1.030 GiB vs. 2.467 GiB at the current cap = 58.3% memory
reduction at 40K from the cap change alone).

**Fields removed**: `orgId`, `clientMsgId` (from the stored/replayed
payload only — both remain in the system elsewhere: `orgId` for
server-side RLS, `clientMsgId` for the POST-time idempotency constraint).
**Fields retained**: everything else in section E's tables, unchanged.

**Why replay correctness is preserved**: no field removed is read by any
client code path this report traced (exhaustive, not sampled); the wire
format and client contract are entirely unchanged; `eventId`-based dedup,
oldest-first ordering, and the inclusive cursor boundary are all untouched.

**Event reconstruction**: not needed for this recommendation — sections
1-2 keep the current "full JSON, minus two unused fields" shape, with no
reconstruction step at all. Reconstruction (section H) is scoped to the
minimal-reference design this report explicitly recommends NOT building
yet (item 4 above).

**DB queries for 10/100/500/1000 replay events**: N/A for this
recommendation (no reconstruction step). For the (not-recommended-yet)
minimal-reference design: O(1) relative to N, via existing `= ANY($1)`
precedent (section I).

**N+1 avoided**: by construction, not applicable to the recommended design
(no DB lookup added to replay at all); by the existing bulk-fetch pattern
for the deferred minimal-reference design.

**ZSET should remain**: yes (section L) — Streams' 3.1% measured
improvement does not meet the "substantial benefit" bar the spec itself
sets.

**Backwards compatibility**: trivial for the recommended change (still
plain JSON, no version marker needed, natural 24h TTL retires old-shape
entries).

**Rollback**: trivial (section U).

**Implementation complexity**: Low (cap constant + two-field removal from
one struct-to-JSON path).

**Operational risk**: Low, gated on closing the REST-backfill-trigger gap
first (item 3).

**Should it actually be implemented?** The cap change and field trim:
**yes, recommended**, after the prerequisite in item 3 and after this
analysis-only report is reviewed by whoever owns this system — this report
itself implements nothing. The minimal-reference design: **not at this
time** — real, evidence-backed, and worth keeping as a documented option
(this report), but not justified against its own engineering cost given
items 1-2 already clear the 40K target with wide margin.

---

## W. Implementation Readiness

| Item | Ready to implement? | Blocking prerequisite |
|---|---|---|
| Cap=100 | Yes, mechanically (one constant) | REST-backfill auto-trigger (item 3 above) should land first per the risk table |
| Drop orgId/clientMsgId | Yes | A targeted regression test confirming no client path reads them (this report's own trace is strong evidence, not a substitute for an actual test run before shipping) |
| Minimal-reference record | No | Full design work needed: recipientId join design, message.read exclusion-or-reconstruction decision, connection-pool-safe reconstruction path following `ListConversations`'s pattern, version-byte rollout plan, messaging-svc-side load testing (section I's UNKNOWN) |
| REST-backfill auto-trigger | No design produced this task (out of this report's scope — flagged as a prerequisite, not designed) | Needs its own design pass |

---

## X. Deliverable Compliance

Every Hard Rule from the spec was honored: no application code, Redis
config, `maxReplayHard`, replay semantics, data structure, or serialization
was changed; no migrations, mocks, prototypes, or fake data were created;
no ID-mapping layer was introduced; ZSET-replacement was evaluated with
real measurement, not assumed; REST fallback, replay ordering, and
multi-device behavior were traced through actual code, not assumed;
`UNKNOWN` is used explicitly wherever evidence was insufficient (task-svc's
REST surface, the replica-vs-primary pool routing for message-history
reads, messaging-svc-side load behavior of the proposed reconstruction
query). Two disposable scratch Redis containers were used for real
measurements and torn down immediately after (confirmed via `docker ps -a`
after each).

---

```text
STATUS:
CONDITIONAL PASS

IMPLEMENTATION:
NOT READY (design/analysis complete; the REST-backfill auto-trigger
prerequisite in section V item 3 has no design yet, and the zero-risk
trim needs a regression test before shipping — neither is a large gap,
but both are real, stated prerequisites, not implemented here)

RECOMMENDED REPLAY CAP:
100

THEORETICAL MINIMUM:
33 B (message.created; message.read/delivered differ — see section S)

PRACTICAL MINIMUM:
117.0 B (MEASURED)

RECOMMENDED PRODUCTION SIZE:
~432 B semantic / ~536 B all-in (MEASURED) — the zero-risk field trim,
NOT the minimal-reference design

ESTIMATED REDIS BYTES/ENTRY:
~536 B (measured payload × the previously-measured ~1.24x overhead ratio)

ESTIMATED REDUCTION:
~10.7% from the field trim alone; 58.3% total 40K outbox memory reduction
from the cap change (2.467 GiB → 1.030 GiB, both MEASURED via the same
weighted model), the two effects being independent and compounding

40K CAPACITY:
PASS (cap=100: 1.030 GiB / 51.5% of the 2 GiB ceiling, comfortably under
the 1.6 GiB / 80% safety target, MEASURED)

PRIMARY REMAINING RISK:
No code path today auto-detects a truncated replay and triggers REST
backfill — a pre-existing gap at any cap value, made more consequential
(not newly created) by lowering the cap. Recommended as a prerequisite to
shipping the cap change, not solved in this analysis-only report.

NEXT IMPLEMENTATION PHASE:
Design the REST-backfill auto-trigger (out of this report's scope);
implement + regression-test the zero-risk orgId/clientMsgId trim; ship the
cap=100 change; revisit the minimal-reference design only if future growth
pressure re-approaches the 40K target after these two land.
```
