# BlissWork scan — Report 1 of 3: BUGS

Scan date 2026-10-06 · scope `Bliss-Work/` · method: `go vet`, `ruff`, live docker inspection, then a code-reading audit per area (Go, Python batch A/B, web frontend, desktop/mobile/graph-gw/scripts/infra).
`tsc` / `eslint` / `vitest` could **not** be run (root `node_modules` is gutted — see B-REPO-1), so TypeScript findings come from reading code. `go vet` was clean. `ruff` (F,B,PERF,SIM,S110) found nothing real beyond the residuals listed in B-REPO-6.
Every entry was verified by reading code by the agent that reported it; the 7 highest-impact claims were additionally re-checked by hand (marked ✔).
Severity: **High** = data loss / outage / security / ships wrong thing · **Med** = wrong behaviour users or ops will hit · **Low** = edge case, hygiene.

Companion reports: `2-BOTTLENECKS.md`, `3-OPTIMISATIONS.md`.

## Fix first (all High)
| # | Where | One-liner |
|---|---|---|
| B-EW-1 ✔ | email-worker worker.py:225 | DB blip during claim → invite/reset/verify email silently lost |
| B-EW-2 | email-worker relay_consumer.py:567 | Provider 409 retried forever → Kafka partition stalls |
| B-INT-1 | integrations internal.py:264,521 | Mail/message claim stuck `sending` forever → feeds B-EW-2 |
| B-MSG-1 ✔ | messaging inbox.go:222 | Opening a THREAD inbox item pins `last_read_seq` = MaxInt64 |
| B-NOT-1 | notification-svc consumer.go:641 | One NUL byte in a message body crash-loops all notifications |
| B-DSK-1 ✔ | desktop ws-process.ts:66 | `stickyBase` never passed → pin sync / acks dead |
| B-MOB-1 ✔ | mobile build.gradle:115 | Release APK signed with public debug keystore |
| B-MOB-2 | mobile usePushRegistration.ts:35 | Remote push cannot register on Android or iOS |
| B-CI-1 ✔ | Jenkinsfile:34 | graph-gw never built/pushed, registry deploy pulls it → deploy fails |
| B-CI-2 | Jenkinsfile:43-93 | Change-detection omits shared libs → stale shared code shipped |
| B-CI-3 | Makefile:484 | Failed-deploy rollback `git reset --hard` destroys dirty tree |
| B-INF-1 ✔ | alertmanager.yml:38 | Prod alerts go to a dev sink that 404s — nobody is paged |

---

## Go services

### notification-svc
- **B-NOT-1 [High] NUL byte crash-loops the consumer** — `services/notification-svc/internal/consumer/consumer.go:641` (messagePreview), `:681-770`, `:182/:194/:233` (`c.stop()`). messaging-svc accepts U+0000 in a body; notification-svc copies a 140-rune preview into `notifications.text`; Postgres rejects NUL (22021); that is not `errMalformed`, so the batch is treated as transient and the consumer stops, restarts, hits the same row — partition blocked for good. One DM stops all notifications. **Fix:** strip NUL from every event-derived text; treat SQLSTATE class 22 as malformed → dead-letter.
- **B-NOT-2 [Low] Changed migration files silently re-executed on boot** — `internal/db/db.go:79-160` (same logic in `messaging-svc/internal/store/store.go` Migrate). Checksum mismatch → whole file re-runs with only a Warn; non-idempotent edits (e.g. full-table UPDATE in `003_outbox_org_purge.sql`) re-run on every replica. **Fix:** fail startup on mismatch; require a new numbered migration.

### ws-gateway
- **B-WS-1 [Med] Routed delivery loses events on transient Redis error** — `internal/router/router.go:107-124`, `router/consumer.go:104-109`. Unlike fanout.go (3 attempts), a failed `AppendOutboxMulti` is only logged; failed `NodesForUsers` returns without pushing; offset is still committed. **Fix:** return error from Route, don't commit / retry with backoff.
- **B-WS-2 [Med] Delivery-ack circuit breaker counts non-retryable 4xx** — `internal/delivery/delivery.go:226,253-256`, `server/conn.go:357-363`, `messaging-svc/internal/api/internal_delivery.go:60-69`. A `message.ack` with a garbage id makes messaging 400 the whole batch; 5 such failures drop all delivery acks for 10 s; one abusive socket can hold it open. `flushDue` also sends serially (up to 3×5 s per recipient). **Fix:** validate UUIDs in gateway, don't count 4xx, flush concurrently (bounded).
- **B-WS-3 [Low] Delivery acks beyond 256 ids silently dropped** — `delivery/delivery.go:71,186-190` vs `internal_delivery.go:60-62` (truncates to 256, returns 204). **Fix:** chunk to 256 in `Dispatcher.send`.
- **B-WS-4 [Med] Hydrate failure silently deletes replay entries** — `internal/hydrate/hydrate.go:104-114`, `server/conn.go:588-603`. If the single hydrate call fails/times out (5 s) all those messages are dropped from replay, `replay.done` still sent, client cursor advances — happens exactly during reconnect storms. **Fix:** retry, or signal resync / close socket.
- **B-WS-5 [Med] Presence race on page reload** — `store/presence.go:193-207`, `server/conn.go:68-83,87-119`. Old socket reads ZCARD=0; new socket AddPresence (added=0, no online event); old socket's ZREM + `presence.offline` fire after → user shows offline up to 45 s with no correcting event. **Fix:** atomic Lua remove-if-empty.
- **B-WS-6 [Low] Heartbeat can resurrect a closed socket's presence** — `server/conn.go:44,87-119`, `store/presence.go:99-125`. In-flight `TouchPresence` ZADDs after `RemovePresence` → ghost online up to 120 s. **Fix:** cancel/stop writeLoop before cleanup; skip Touch once Done.

### messaging-svc
- **B-MSG-1 [High] `upToSeq` never clamped** — `internal/api/inbox.go:222` (math.MaxInt64), `store/receipts.go:324-420,451-535`, `store/channels_receipts.go:41-60`, `api/api.go:940`. One "read" of a THREAD inbox item sets `thread_members.last_read_seq`=9.2e18 → unread count 0 forever (threads.go:331), later reads insert no receipts so sender never sees "Seen", peer receives MessageRead with MaxInt64. Any client can also send huge `upToSeq` on `/conversations|threads|channels/{id}/read` to spoof reads. **Fix:** clamp to current max seq in store and event.
- **B-MSG-2 [Med] Plaintext bodies in outbox / Kafka / notifications defeat column encryption** — `store/messages.go:628`, `store/append_channel.go:125,201`, `notification-svc/.../consumer.go:489,511`. Bodies encrypted in `messages`/`channel_messages`, but plaintext jsonb in `outbox.payload` (kept 7 days after publish), on Kafka, and a permanent 140-char preview in notifications. DB dump exposes content; crypto-shredding an org doesn't remove it. **Fix:** ids only + hydrate, or encrypt outbox payload and notifications.text.
- **B-MSG-3 [Med] Auth consumer gives up after 8 attempts (~90 s) and commits** — `internal/kafka/consumer.go:64-92,134-146`. DB outage >~91 s turns `user.created/deactivated/org.deleted` into a logged skip with no DLQ → projection never gets user; deactivation / org purge never applied. Task projector uses the same helper. **Fix:** dead-letter or retry indefinitely with capped backoff.
- **B-MSG-4 [Med] Idempotency middleware returns 204 for duplicates while original in flight or crashed** — `internal/middleware/idempotency.go:77-96`. Bare INSERT claim, no in-progress/complete state: retry during original gets 204 even if original later fails; crash after claim leaves key 24 h so every retry is a silent no-op; keys not bound to route. **Fix:** store route + state/response; 409 or stored response; expire stale claims.
- **B-MSG-5 [Low] Concurrent thread reply with same clientMsgId → 500** — `store/messages.go:495-515`, `api/errors.go`. Replies path takes no conversation lock; second INSERT hits 23505. **Fix:** `ON CONFLICT DO NOTHING RETURNING` or map 23505 to re-read.
- **B-MSG-6 [Med] createChannel / addChannelMembers accept unbounded memberIds and emit full-roster event per added member** — `api/channels.go:25-50,274-297`, `store/channels.go:73,340-372`, `store/append_channel.go:181-205`. K added to M-member channel = K channel_messages + K outbox rows each carrying M ids (K=1000,M=5000 ≈195 MB in one tx); ~27k ids creates events > 1 MiB that dead-letter and are never delivered. **Fix:** cap memberIds, one batched system event, multi-row insert.
- **B-MSG-7 [Low] Hydrated replay events carry wrong `recipientId`** — `store/hydrate.go:204`. `threads.recipient_id` is the root message's recipient, not this message's → replayed frames differ from live; `packages/app/src/lib/inboxPatch.ts:39` then picks the user itself as peer on multi-device echoes. **Fix:** `CASE WHEN m.sender_id = t.sender_id THEN t.recipient_id ELSE t.sender_id END`.
- **B-MSG-8 [Low] Draft attachment removal can delete a blob a concurrent upload is about to reference** — `store/mail_draft.go:361-369`, `api/mail.go:135`. **Fix:** only GC deletes blobs, or lock per sha.
- **B-MSG-9 [Low] `ListMyCalls` returns farthest-future first, cuts off soonest** — `store/calls.go:1418-1445` (`ORDER BY at DESC LIMIT`, default 50 / max 100). Live/imminent calls dropped. **Fix:** LIVE + soonest first, or cursor paging.

### sticky-relay
- **B-SR-1 [Low] 12th (last allowed) nudge claimed but never sent** — `internal/sweep/sweep.go:137` (`DeliveryAttempts < MaxNudges`) vs sticky-svc `routes/internal.py` (RETURNING post-increment, `WHERE delivery_attempts < 12`). **Fix:** `<=` or rely on server cutoff.
- **B-SR-2 [Low] Failed publish after claim burns delivery attempts** — `cmd/sticky-relay/main.go:110-130`. Kafka outage walks pins up the 5–60 min ladder with nothing sent. **Fix:** claim/confirm step or increment after publish.

### region-bridge
- **B-RB-1 [Med] With DLQ disabled importer Naks poison messages until MaxDeliver (64), then they vanish** — `internal/bridge/import.go:239-246`, `streams/provision.go:49`. **Fix:** `Term()` classification rejects regardless of DLQ; Nak only transient write failures.
- **B-RB-2 [Low] Health state shared across per-topic goroutines** — `internal/health/health.go:78-90`, `bridge/export.go:86-120`. One healthy topic's `Progress()` erases another's stall → `/readyz` stays green; `SetKafka` flaps. **Fix:** track per (direction, topic).

## auth-svc
- **B-AUTH-1 [Med] Password-only session for existing identity bypasses MFA** — `app/routes/auth.py:53` (create_org), `routes/invites_service.py:254` (accept_invite_tx), `routes/auth.py:619` (leave_org). No `mfa_gate`; password holder gets a full session then `/auth/orgs/mine` and identity-wide `/auth/orgs/{id}/leave` (no MFA). **Fix:** run mfa_gate when identity has enrolled membership; step-up on leave_org.
- **B-AUTH-2 [Med] Unverified-identity pre-registration blocks the real owner** — `service.py:1015`, `invites_service.py:254`. Attacker create_org with victim's email + chosen password; later accept_invite for the victim demands attacker's password, 401, and bumps victim's lockout. **Fix:** on invite redemption of an unverified identity overwrite password, mark verified, revoke sessions.
- **B-AUTH-3 [Med] Pool self-deadlock (second connection inside open tx)** — `service.py:1099` (`engine.begin() as lockout_conn` in resolve_or_create_identity), called from `auth.py:53`, `invites_service.py:254`; pool `db.py:18` (5+5). ~10 concurrent wrong-password attempts wait on each other for the 30 s pool_timeout; attacker-triggerable. **Fix:** record lockout after the tx closes, as `/auth/login` does.
- **B-AUTH-4 [Low] `presence_memberships` "fail soft" doesn't** — `service.py:441`. Failed statement aborts the PG tx; next statement (refresh-token insert) fails → login/refresh 500. **Fix:** savepoint.
- **B-AUTH-5 [Low] Unique-constraint races → 500** — `service.py:63` (unique_slug check-then-insert), `invites_service.py:316` (no check of `body.username` vs UNIQUE(org_id,username)); traceback logs bound params incl. password hash. **Fix:** catch IntegrityError in savepoint; 409.
- **B-AUTH-6 [Med] CAPTCHA skipped by client-declared platform** — `routes/captcha_service.py:165` (`is_exempt_platform`). `clientPlatform:"macos"|"ios"` skips CAPTCHA; scripted credential stuffing on `/auth/login`. **Fix:** verifiable attestation / server token, or remove.
- **B-AUTH-7 [Low] CAPTCHA verify non-atomic** — `captcha_service.py:202-225`. N concurrent requests with one captchaId pass the attempts check. **Fix:** atomic GETDEL/HINCRBY Lua.
- **B-AUTH-8 [Med] Step-up re-auth failures never count toward lockout** — `routes/mfa_service.py:296` (`verify_step_up`), used by `mfa_totp.py`, `mfa_challenge.py` (`/auth/mfa/disable`, backup-codes regenerate, enroll-confirm overwrite). Stolen access token can guess password/TOTP at only 5/min/IP. **Fix:** `register_failed_login` (separate committed tx).
- **B-AUTH-9 [Low] TOTP comparison not constant-time** — `mfa_service.py:195`. **Fix:** `secrets.compare_digest`.
- **B-AUTH-10 [Low] Forgot-password timing reveals whether email exists** — `account_service.py:141`. **Fix:** background task or pad.
- **B-AUTH-11 [Low] Password reset doesn't clear identity lockout** — `account_service.py:199`. **Fix:** `reset_identity_lockout` in `reset_password_tx`.
- **B-AUTH-12 [Low] Org deletion request doesn't stop re-login** — `routes/org_lifecycle.py:83`. Login/refresh/switch never check `orgs.purge_after`/`delete_requested_at`. **Fix:** reject sessions for pending-deletion orgs.
- **B-AUTH-13 [Low] create_org distinguishes registered emails** — `auth.py:53` (409 "already registered" for wrong password vs success). Account enumeration behind a bypassable CAPTCHA. **Fix:** one generic response.
- **B-AUTH-14 [Med] Routing consumer commits past an event that failed to apply** — `routing/consumer.py:88`. Transient DB error logged "routing_event_skipped" then `commit()` → permanent loss of org/invite routing row; invite redemption 503s until expiry; commits per message. **Fix:** retry/seek back; commit per batch.
- **B-AUTH-15 [Low] Capacity alert task has no strong reference** — `routing/notify.py:92` (`ensure_future` + done_callback only; loop holds tasks weakly). **Fix:** module-level set.
- **B-AUTH-16 [Med] Per-key ordering not preserved with two poller replicas** — `events/poller.py:126`, `task-svc/app/outbox.py`, `sticky-svc/app/outbox.py`. `SKIP LOCKED` + `ORDER BY created_at` across 2 replicas: B publishes newer rows for a key while A is stuck on an older one → consumers can see `user.removed` before `user.created`. **Fix:** single leader (advisory lock) or shard by key.
- **B-AUTH-17 [Low] CORS allows credentialed `null`/file:// origins in prod** — `main.py:138`, `security/origin.py:40`. Safe only while `COOKIE_SAMESITE=lax`; if set to `none`, any sandboxed iframe can call `/auth/refresh`. **Fix:** drop `null` from prod allow-list.
- **B-AUTH-18 [Med] DB engines log bound SQL parameters (cross-service)** — `auth-svc/app/db.py:18`, `task-svc/app/db.py:25`, `sticky-svc/app/db.py:25`, `integrations-svc/app/db.py:23-34`, `telemetry-svc/app/db.py:19-31` (no `hide_parameters=True`); logged via `auth-svc/app/errors.py:80` and `str(exc)` in task-svc consumer/outbox. A failing users INSERT logs `password_hash`; failing task-svc outbox INSERT logs plaintext title/description. **Fix:** `hide_parameters=True` on all five engines.
- **B-AUTH-19 [Low] BodySizeLimitMiddleware only checks Content-Length** — `middleware.py:31`. Chunked bodies unbounded in-app. **Fix:** streamed byte cap.

## services/shared (Python)
- **B-SH-1 [Med] Oversize-quarantine binds int to text param** — `outbox_dlq/outbox_dlq.py:52` (`_QUARANTINE_OVERSIZE`, `|| :limit ||`). Postgres infers `$1` as text (confirmed with PREPARE on dev DB); asyncpg rejects Python int → `quarantine_oversize` raises, oversized row blocks the outbox in every service. Tests mock the connection. Triggers only for payload > 1 MiB. **Fix:** `CAST(:limit AS text)` or `str(...)`.
- **B-SH-2 [Low] `internal_token_matches` raises TypeError on non-ASCII** — `internal_auth/internal_auth.py:42` → 500 instead of 401. **Fix:** compare `.encode()` bytes.
- **B-SH-3 [Low] CircuitBreaker records cancellation as success; half-open admits everyone** — `resilience/resilience.py:144,96`. **Fix:** re-raise CancelledError untouched; single probe.
- **B-SH-4 [Low] `rotate_dek` caches new DEK before commit** — `crypto/crypto.py:526`. Rollback leaves a cached key no `org_keys` row backs → writes undecryptable after restart; concurrent rotations collide on max_v+1. **Fix:** `_keep_until_commit` + advisory lock.

## task-svc
- **B-TASK-1 [Med] Recurrence computed in UTC** — `app/schedule_worker.py:71,110`; client sends local `startAt`/weekdays (`packages/app/src/features/CreateTaskDialog.tsx:226-236`). WEEKLY uses UTC `weekday()`, MONTHLY UTC `day`, DAILY +24h → wrong weekday for UTC+10 users, ±1 h at DST. **Fix:** store recurrence tz; zoneinfo wall-clock arithmetic.
- **B-TASK-2 [Med] Missed occurrences replayed as a burst** — `schedule_worker.py:300`. next_run from old next_run_at: after N missed periods, N tasks + notifications, up to 50/tick. **Fix:** skip beyond grace window / advance past now.
- **B-TASK-3 [Med] Outbox oversize quarantine self-deadlocks** — `task-svc/app/outbox.py:163`, `sticky-svc/app/outbox.py:165`, `integrations-svc/app/outbox.py:120-135` (same pattern). Second session (`db2`) UPDATEs rows locked FOR UPDATE by the first; hangs to 30 s statement_timeout, row never quarantined, error every tick. auth-svc reuses the connection and avoids it. **Fix:** same connection, or commit first.
- **B-TASK-4 [Low] No DataError→400 handler: non-UUID path id → 500** — task-svc `errors.py:87` (routes `transitions.py:35`, `participants.py`, `reviews.py`, `schedules.py:84`, `tasks_read.py`), sticky-svc `errors.py:82`, `routes/pins.py:116`; **also** integrations-svc and telemetry-svc `errors.py`. auth-svc has one. **Fix:** type params `uuid.UUID` or register the handler.
- **B-TASK-5 [Low] Idempotency key org-scoped, not user-scoped** — `routes/tasks_write.py:329`. User B replaying A's key gets A's taskId. **Fix:** key on (org, sender, key) + body fingerprint.
- **B-TASK-6 [Low] Duplicate-case UUIDs → spurious 400** — `routes/participants.py:86`. **Fix:** canonicalise.
- **B-TASK-7 [Low] Consumer drops event after 8 attempts; projection upserts order-sensitive** — `consumer.py:90,378`. `user.deactivated` before `user.created` updates 0 rows and later upsert leaves user active (compounds B-AUTH-16). **Fix:** DLQ + version-aware upsert.

## sticky-svc
- **B-STK-1 [Med] Poison event blocks consumer forever** — `app/consumer.py:200,319`. `senderId` is the one id not UUID-validated → DataError every retry; `_process_batch` returns False with no attempt cap; 1 s retry loop, all pin updates stall. **Fix:** validate senderId; cap attempts / dead-letter.

## email-worker
- **B-EW-1 [High ✔] DB error during claim silently drops invite/reset/verify emails** — `app/worker.py:225-227` (`_claim` at 506-511). `_claim` returns False for both "already sent" and a DB exception; `_handle_message` treats False as `duplicate_skipped` → returns True → offset commits. Docstring says the opposite. **Fix:** raise / tri-state; return False from `_handle_message` on claim error.
- **B-EW-2 [High] Uncapped retry on provider failure blocks the Kafka partition** — `app/relay_consumer.py:567-574` (cause `integrations-svc/app/routes/internal.py:567-589,311-329`). `ProviderMailUnavailable` releases the claim, returns False, never counted toward `poison_max_failures`; a 409 from integrations (claim left 'sending') maps to it every time; batch rewinds every ~2 s forever. **Fix:** cap per mail_id; SMTP fallback / DLQ after N.
- **B-EW-3 [Med] Claims left 'pending' after `_on_failure`, wedging partition ≥180 s** — `relay_consumer.py:592-594,626-627,900-912`. UNDECIDED / SMTP-failure paths skip `_retry_or_dlq`; DLQ'd event keeps pending row; redelivery conflicts until reaper (`_REAP_SEND_BUDGET_SECONDS`=180). **Fix:** release claim on every False/DLQ path; mark DLQ'd terminal.
- **B-EW-4 [Med] DLQ scrub misses recipient, subject, chat content** — `relay_consumer.py:78-79,983-987`. `_MAIL_CONTENT_FIELDS` omits `envelope`, `cc`, `subject`, `fromName`, `attachments`; message.created/task.assigned carry `body`/`title`/`description` into the no-ACL DLQ topic in clear. **Fix:** allow-list (eventId,type,orgId,mailId).
- **B-EW-5 [Low] Permanent SMTP errors retried like transient** — `app/mailer.py:229-235`. 5xx/auth errors get 5 attempts + 3 redeliveries while partition stalls. **Fix:** classify; 5xx straight to poison path.
- **B-EW-6 [Low] Migrations run on every boot of every replica, no lock/ledger** — `relay_consumer.py:1350-1366`. Races; `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE on a hot table. integrations/telemetry already have advisory lock + ledger. **Fix:** reuse `run_migrations` pattern.
- **B-EW-7 [Low] Event-supplied ids interpolated unencoded into internal URL paths carrying the internal token** — `relay_consumer.py:1048`, `attachments.py:150`, `worker.py:267`. Forged `../` from ACL-less Kafka topics. **Fix:** validate UUID / `quote(safe="")`.
- **B-EW-8 [Low] Recipient/sender emails logged at INFO** — `worker.py:331,366,401`, `relay_consumer.py:1104,1140`. **Fix:** ids / masked.

## integrations-svc
- **B-INT-1 [High] Mail/message claim stays 'sending' forever after any unclassified failure** — `app/routes/internal.py:264-329 (messages), 521-589 (mail)`, `providers/slack.py:48`, `providers/gmail.py:117-119`. Bare `HTTPStatusError` (Slack/Gmail any 4xx/5xx), Gmail header `ValueError`, any bug or crash leaves row 'sending'; every retry → 409 forever (wedges email-worker, B-EW-2). **Fix:** catch-all marks 'failed' if provider not contacted; reaper for stale 'sending' (`idx_mail_send_attempts_stuck` exists).
- **B-INT-2 [Med] In-flight token refresh resurrects a just-disconnected connection** — `refresh_worker.py:197-258`, `routes/integrations.py:431-447`. UPDATEs lack status guard; if Phase C fails after Microsoft rotated the refresh token, the new token is lost and retry gets invalid_grant. **Fix:** `AND status='connected'`; keep claim until persisted.
- **B-INT-3 [Med] OAuth `state` is a bearer value not tied to initiating browser** — `routes/oauth.py:105-127`, `routes/integrations.py:272-332`. Login-CSRF / consent phishing: victim's mailbox connected to attacker's account. **Fix:** bind state to short-lived cookie / session hash.
- **B-INT-4 [Low] Disconnect never revokes token at provider** — `routes/integrations.py:418-451` (docstring says "revoke + purge"). **Fix:** best-effort provider revocation.
- **B-INT-5 [Low] Graph 503/504 on /sendMail treated as "definitely not sent"** — `providers/microsoft.py:68-72`, `internal.py:533-537`. Gateway timeout after acceptance → duplicate external email. **Fix:** 504 (and 503 w/o Retry-After) = ambiguous.
- **B-INT-6 [Low] Refresh sweep serial, no per-row backoff, failing rows retried first** — `refresh_worker.py:62-113`. ≥50 failing rows starve healthy connections. **Fix:** `next_attempt_at` backoff / bounded concurrency.
- **B-INT-7 [Low] org.deleted consumer retries a failing event forever; skips send-attempt tables** — `org_consumer.py:55-62,112-135`. Docstring says poison is skipped; `_TABLES` omits `mail_send_attempts`, `message_send_attempts`. **Fix:** per-message catch; add tables.
- **B-INT-8 [Low] Teams `chat_id` interpolated unencoded into Graph URL** — `providers/microsoft.py:208-213`, `outbound.py:104-111`. **Fix:** `quote(chat_id, safe="")`.

## telemetry-svc
- **B-TEL-1 [Med] One event with non-UUID org/user id wedges the whole consumer** — `app/consumer.py:311-340,369-385`, `ingest.py:166-182`. `orgId`/actor only length-bounded; uuid column → DataError → re-raised → batch rewinds every 1 s with no DLQ/skip, blocking all five topics. **Fix:** validate UUIDs in `to_activity_row`.
- **B-TEL-2 [Med] Beacon `detail` unbounded** — `schemas.py:29-33`, `routes/ingest.py:94-105`, `jobs/rollup.py`. `dict[str,str]` no size cap (~1 MiB × 120/min × 90 days); free-string `action`/`surface` grow `activity_daily.by_action/by_surface` forever. **Fix:** constrain / allow-list.
- **B-TEL-3 [Low] Kafka events >24 h late get falsified timestamps** — `consumer.py:340`, `ingest.py:87-101` (`max_clock_backdate_seconds`=86400). **Fix:** no backdate clamp for `source='server'`.
- **B-TEL-4 [Low] Retried beacon events duplicate when `occurredAt` missing/clamped** — `routes/ingest.py:95`, `migrations/0006…` (unique incl. occurred_at). **Fix:** dedup on (org,user,client_event_id) or require occurredAt.
- **B-TEL-5 [Low] `ip_prefix` wrong /48 for compressed IPv6** — `sessions.py:79-81` (`2001:db8::1` → `2001:db8:1::/48`). **Fix:** `ipaddress`.
- **B-TEL-6 [Low] Single beacon can claim 24 h active/idle** — `schemas.py:50-51`, `sessions.py:_TOUCH_SESSION`. **Fix:** clamp to elapsed since last_seen_at.
- **B-TEL-7 [Low] Today's live bucket ignores sessions started before midnight UTC** — `routes/analytics.py:293,324-336`. Live ≠ rolled-up. **Fix:** same overlap/clip as `_SESSION_ROLLUP`.
- **B-TEL-8 [Low] Non-UUID `sessionId` or forged cursor id → 500** — `schemas.py:48`, `cursor.py:31-44`, `routes/timeline.py`. **Fix:** validate.

## Web frontend (packages/app, packages/shared, packages/ui, apps/web)
- **B-WEB-1 [Med] No cache resync after WS reconnect beyond 200-event replay** — `packages/shared/src/ws-client/WsClient.ts` (onStatus), `packages/app/src/lib/queryBridge.tsx:90-199`; no `onStatus` consumer in app. Sleep/network loss/deploy gap → stale messages/inbox/tasks; `refetchOnWindowFocus` false. **Fix:** invalidate active queries on closed→open.
- **B-WEB-2 [Med] One throwing handler aborts delivery to the rest and event is never retried** — `WsClient.ts:421-429` (eventId added to `seen` before `for h of handlers`). Later subscribers (e.g. useCallRoom CallEnded) miss it. **Fix:** try/catch per handler.
- **B-WEB-3 [Med] Own messages from another tab/device never appear live in open thread** — `queryBridge.tsx:356-375,532-554` (skip when `senderId===me`). Also forwards / call-missed notices. **Fix:** skip only when matching `temp:` row pending; else append/invalidate.
- **B-WEB-4 [Low] WS access token in URL query** — `WsClient.ts:269`. Proxy/gateway logs. **Fix:** single-use ticket or first-frame auth.
- **B-WEB-5 [Low] Stale presence poll overwrites newer live event** — `lib/usePresence.ts:72-92` (up to 20 s). **Fix:** ignore polls started before last presence event.
- **B-WEB-6 [Med] Camera "off" in 1:1 call keeps device captured** — `lib/callManager.ts:430-455` (`enabled=false` + `replaceTrack(null)`, track never stopped; camera light stays on). **Fix:** stop/remove track; re-acquire on.
- **B-WEB-7 [Med] Local recording freezes in hidden tab (rAF); buffers whole file in RAM** — `lib/localRecording.ts:202,218,230-246` (~1.1 GB/h, lost on crash). **Fix:** setInterval/Worker timer; spill to OPFS.
- **B-WEB-8 [Low] Recorder `onError` leaks draw loop, AudioContext, hidden DOM host** — `lib/useLocalRecording.ts:86-90`. **Fix:** call stop/release.
- **B-WEB-9 [Low] Join awaiting token when room unmounts creates orphan Room** — `lib/useCallRoom.ts:440-700` vs cleanup ~965-985. User stays on roster. **Fix:** mountedRef / abort generation.
- **B-WEB-10 [Low] `joining.current` can stay true forever** — `useCallRoom.ts:455-470` (stale-room disconnect outside try/finally). **Fix:** move inside.
- **B-WEB-11 [Low] Mic/camera error toasts hard-coded English** — `useCallRoom.ts:844-851,867-874`, `queryBridge.tsx:57` ("Meeting"/"Channel call"). **Fix:** catalog.
- **B-WEB-12 [Low] "Missed call" body stored/sent in caller's language** — `lib/useCall.tsx:164`. **Fix:** structured kind, localise client-side.
- **B-WEB-13 [Low] Meeting chat/notes written to localStorage forever** — `lib/callChat.ts:183-190`, `lib/callNotes.ts:100-108` (from `features/CallRoom.tsx:518-524`); also unscoped `tb.mail.prefs`, `tb.conversation.prefs`, `tb.assigned-task-pin.prefs`. Readable on shared device; quota creep. **Fix:** delete at meeting end/sign-out; key by user id.
- **B-WEB-14 [Med] Messages marked read while tab/window not visible** — `routes/DMView.tsx:143-154`, `routes/ChannelView.tsx:160-166`. No visibility/focus check; re-fires on older-page prepend. Sender sees false "Seen". **Fix:** gate on visible+focused; key on max seq.
- **B-WEB-15 [Med] Any new message yanks reader to bottom** — `features/ChatThread.tsx:~395-405`. No near-bottom check; also temp→real id swap jumps. **Fix:** auto-scroll only near bottom / own message.
- **B-WEB-16 [Low] Search shows/matches raw attachment-envelope JSON** — `routes/Search.tsx:102`, `routes/ChatsList.tsx:164`. **Fix:** `listPreview()` before matching/display.
- **B-WEB-17 [Low] Lightbox doc iframe has no `sandbox`; blob type from response** — `features/Lightbox.tsx:234`, `lib/useBlobUrl.ts:30-45` (also no abort on unmount, raw English errors). **Fix:** `sandbox=""`, re-wrap blob with validated mime.
- **B-WEB-18 [Low] Object URL revoked synchronously after `click()`** — `lib/useWhatsAppMediaForward.ts:105-114`. **Fix:** reuse `downloadBlob`.
- **B-WEB-19 [Low] Path ids not `encodeURIComponent`'d** — `packages/shared/src/api/client.ts:463-490,1094,1239,1973,2491`. Crafted `/call/:callId` with `../` hits another endpoint (same-origin). **Fix:** encode / validate UUID.
- **B-WEB-20 [Low] Upload `ontimeout` dead; body reads unbounded; abort listener leak** — `client.ts:1330` (no `xhr.timeout`), `:245-265` (timer cleared before `res.json()`). **Fix:** set timeout / inactivity timer.
- **B-WEB-21 [Low] Language-list fetch never retried; rapid locale picks race** — `i18n/LanguageProvider.tsx:122-133,147-166`. **Fix:** reset flag in catch; request counter.
- **B-WEB-22 [Low] Due-date `min` uses UTC date** — `features/CreateTaskDialog.tsx:341`, `features/ExportTasksDialog.tsx:88`. "Today" unselectable west of UTC in evening. **Fix:** local Y-M-D.

## Desktop (apps/desktop)
- **B-DSK-1 [High ✔] ws-process ApiClient never given `stickyBase`** — `src/main/ws-process.ts:66-81` (`build()`); `main/index.ts:75` does send it. `stickyPinStates()` returns null, `stickyPin/Unpin` reject "sticky service is not configured" (`client.ts:1944`), `stickyAckDelivery` no-ops → Unpin device-local, no cross-device sync, delivery watchdog never acked. **Fix:** add to cfg type and pass `stickyBase: cfg.stickyBase`.
- **B-DSK-2 [Med] Tray/menu Quit destroys meeting windows before graceful-leave** — `main/index.ts:619-629` (`quitApp`) vs `1214-1244` (`before-quit`); `meeting-window-manager.ts:104-107`. `leaveCall()` never posted; resume-meeting marker never cleared. **Fix:** drop `destroyAll()` from `quitApp()`.
- **B-DSK-3 [Med] Pinned-chat window shows every sent message twice, swallows send failure** — `renderer/sticky-chat.tsx:60,82,141`, `main/ws-process.ts:249-255,337-347`. Temp bubble id `temp:<clientMsgId>` never matched by echo; failed `replyToThread` ignored. **Fix:** carry clientMsgId; surface failure.
- **B-DSK-4 [Med] OS Notification objects not retained** — `main/notifier.ts:198-203`. GC before click loses handler on Win/macOS. **Fix:** module-level Set.
- **B-DSK-5 [Med] P2P file-sink filename sanitiser weaker than attachment-open's** — `main/file-sink.ts:46-49`. `:` kept (NTFS ADS), trailing dots/spaces, reserved names, length. **Fix:** reuse `attachment-open.ts:36-42` sanitize.
- **B-DSK-6 [Low] `filesink:open` trusts renderer size, no stream error listener** — `file-sink.ts:99-118`. 1e15 reserves "allowed" disk; `createWriteStream` errors → uncaughtException; `existsSync` + non-exclusive open race. **Fix:** cap, `stream.on('error')`, `flags:'wx'`.
- **B-DSK-7 [Med] Executable denylist for downloaded attachments misses launchers** — `main/attachment-open.ts:70-82`. Missing `.sh .command .app .pkg .dmg .desktop .appimage .deb .rpm .jnlp .msix .appx .msp .gadget .scf .library-ms .xll .docm .xlsm .pptm .py .pl .terminal .workflow` → straight to `shell.openPath` on macOS/Linux builds. **Fix:** allowlist safe previews; reveal the rest.
- **B-DSK-8 [Med] Second-source integrity check verifies `files[0]`, not the downloaded artifact** — `main/updater.ts:186-187`. `latest-mac.yml` has multiple entries. **Fix:** select by platform/arch.
- **B-DSK-9 [Low] Auto-start at login forced on every launch** — `main/index.ts:351-355` (`openAtLogin:true`; `openAsHidden` deprecated macOS 13+). **Fix:** set once / setting.
- **B-DSK-10 [Low] "Check for updates" says "downloading" for any differing version** — `updater.ts:277` (`latest !== app.getVersion()`); `manualCheckInFlight` stuck. **Fix:** semver `gt` / `update-available`.
- **B-DSK-11 [Low] Permission handlers ignore requesting origin/frame** — `main/index.ts:262-263`. Grants media/geo/clipboard to every frame incl. `blob:` previews. **Fix:** check against `isOwnContent`.

## Mobile (apps/mobile)
- **B-MOB-1 [High ✔] Release builds signed with debug keystore** — `android/app/build.gradle:115`. Cannot go to Play; anyone can re-sign. **Fix:** release signingConfig from env/EAS.
- **B-MOB-2 [High] Remote push registration cannot succeed** — `src/hooks/usePushRegistration.ts:35`; no `google-services.json`/gms plugin; `ios/…/BlissWorkMobile.entitlements` empty; `index.js:40`. `getExpoPushTokenAsync` throws (logged only), `registerDevice` never called. **Fix:** add FCM + APNs entitlement/background mode, or remove dead code.
- **B-MOB-3 [Med] iOS has no `blisswork://` scheme** — `ios/BlissWorkMobile/Info.plist:28-31`; `navigation/RootNavigator.tsx:27`, `calls/CallProvider.tsx:424`. Quick/call/notification deep links never open on iOS. **Fix:** add scheme + universal links.
- **B-MOB-4 [Med] "Mute notifications" has no effect** — `hooks/useMutedConversations.ts`; callers `screens/chats/ChatConversationScreen.tsx:98`, `screens/more/ChannelConversationScreen.tsx:99`; `calls/messageNotifications.ts:99-115`, `hooks/useWsBridge.ts:139-155` never read it. **Fix:** check persisted set in `showMessageNotification`.
- **B-MOB-5 [Med] Offline/flaky cold start drops user to Login** — `context/AppProviders.tsx:124-126` (any null from `refreshSession` → `clear()`). **Fix:** clear only on terminal codes; retry on foreground/online.
- **B-MOB-6 [Med] Quick-action flow re-opens on every foreground** — `navigation/RootNavigator.tsx:85-87`; `MainActivity.kt onNewIntent`. `getInitialURL()` re-read on resume. **Fix:** consume launch URL once.
- **B-MOB-7 [Med] `blisswork://call/<id>` / join-token links auto-join with camera on** — `calls/CallProvider.tsx:397-425`, `roomController.ts:271-290`. No prejoin; attacker link puts victim on camera. **Fix:** prejoin confirm, mic/cam off.
- **B-MOB-8 [Low] `android:allowBackup="true"`** — `AndroidManifest.xml:40`. **Fix:** false / extraction rules.
- **B-MOB-9 [Low] In-app PDF preview likely blank on Android** — `attachments/AttachmentViewerHost.tsx:82-98` (platform behaviour, not repo code). **Fix:** PDF renderer or external open.

## graph-gw
- **B-GW-1 [Low] `http_requests_*` `path` label is raw URL path** — `src/index.ts:56-66` (comment promises registered path). Scanner traffic → unbounded label cardinality. **Fix:** map to known routes / `other`.
- **B-GW-2 [Low] Drain grace 15 s > Docker stop timeout 10 s** — `src/config.ts` (`SHUTDOWN_GRACE_MS`), `docker-compose.prod.yml:1235-1265` (no `stop_grace_period`). In-flight requests cut on deploy. **Fix:** `stop_grace_period: 20s`.

## Scripts / CI / Makefile
- **B-CI-1 [High ✔] Jenkins never builds/pushes graph-gw but registry-mode deploys pull it** — `Jenkinsfile:34-128` vs `Makefile:301-304`, `docker-compose.registry.yml`. `compose pull` fails → ERR trap rolls back → Deploy stage fails. **Fix:** add graph-gw to `IMAGES`.
- **B-CI-2 [High] Change-detection paths omit shared libs images COPY** — `Jenkinsfile:43-93`. auth/task miss client_ip, internal_auth, jwks_auth, kafka_lazy_producer, logging_setup, outbox_dlq, prune_events, resilience (+org_purge_tables); telemetry, integrations, sticky, email-worker miss several. "Unchanged" images re-tagged from stale `:latest`. **Fix:** derive from Dockerfile COPY lines, or rebuild all on `services/shared/` change.
- **B-CI-3 [High] Failed-deploy rollback `git reset --hard` even with `DEPLOY_ALLOW_DIRTY=1`** — `Makefile:484`. **Fix:** skip/snapshot when started dirty.
- **B-CI-4 [Med] restore-test extracts whole media archive to /tmp** — `scripts/restore-test.sh:30,143-146`; can fill the root fs that also holds Postgres. **Fix:** `tar -tf | wc -l`.
- **B-CI-5 [Med] publish-desktop.sh overwrites live installers non-atomically, ignores backup failure** — `scripts/publish-desktop.sh:111-114,119-122`. Version-less names + `cp -f` while old hash live; `cp -a … || true` still prints "backed up"; backups never pruned. **Fix:** temp+`mv`, abort on backup failure, retention.
- **B-CI-6 [Low] audit-gate allowlist never expires** — `scripts/audit-gate.mjs` (`reviewBy:"2026-10-01"` unchecked; all waivers already past due; tar rationale cites removed get-windows). **Fix:** fail on expired.
- **B-CI-7 [Low] send-alert.py breaks on SMTP 465** — `scripts/send-alert.py:49-51`. **Fix:** `SMTP_SSL`.
- **B-CI-8 [Low] publish-second-source-manifest leaks clone dir; misattributed git identity** — `scripts/publish-second-source-manifest.mjs:145,153` (`process.exit` skips finally; `noreply@anthropic.com`). **Fix:** exitCode; project identity.
- **B-CI-9 [Low] `make prod-rollback` rebuilds web bundle from the un-rolled-back tree** — `Makefile:508-515`. **Fix:** require checkout / skip web rebuild.
- **B-CI-10 [Low] migrate-blobs-to-s3.sh puts S3 secrets on command line; `minio/mc:latest`** — `scripts/migrate-blobs-to-s3.sh` (`mc()`). **Fix:** `MC_HOST_tb` env; pin digest.
- **B-CI-11 [Low] Registry login/verify over plaintext HTTP basic auth** — `Jenkinsfile:172,316-317,628,643`. **Fix:** TLS.

## Infra
- **B-INF-1 [High ✔] Prod Alertmanager routes every alert to a dev sink** — `infra/observability/alertmanager/alertmanager.yml:38` (`http://otel-collector:4318/v1/alerts-dev-sink`, 404), mounted by `docker-compose.prod.yml:1412`. All Prometheus rules fire into nothing. **Fix:** real receiver.
- **B-INF-2 [Med] Prometheus scrapes replicated services by one DNS name** — `infra/observability/prometheus.yml:35-65` vs `docker-compose.prod.yml` replicas:2. Same `instance` label across two processes → phantom counter resets; `up` hides a dead replica. **Fix:** `dns_sd_configs`.

## Repo / environment (found directly)
- **B-REPO-1 [Med] Root `node_modules` is partly wiped** — `node_modules/.bin` missing, `node_modules/eslint/` has no `package.json`, `node_modules/@types/*` empty (mtime Oct 5 12:55). `tsc`, `eslint`, `vitest` cannot run from the workspace; `npm run typecheck/lint/test` is dead until a clean `npm ci` (do it in a scratch copy, per memory note). Everything TypeScript in this scan was by code reading.
- **B-REPO-2 [Low] Integrations outbox poller logs `outbox_producer_connected` on every 0.5 s poll** — `services/integrations-svc/app/outbox.py:67` (live: ~127 lines/min); same pattern `task-svc/app/outbox.py:67`, `sticky-svc/app/outbox.py:69`, `auth-svc/app/events/poller.py:85`. `_ensure_producer` logs unconditionally rather than on first connect. Produced 766–876 MB of docker logs in 6 days. **Fix:** log only when the producer is actually created.
- **B-REPO-3 [Low] email-worker has no health check** — `docker-compose.prod.yml` (service shows `Up`, never `healthy`), `services/email-worker/Dockerfile` (no HEALTHCHECK). A hung consumer is invisible. **Fix:** liveness probe.
- **B-REPO-4 [Low] Dev `task-board-sticky-relay-1` crash-looping** — container log: `STICKY_INTERNAL_TOKEN is required` every ~60 s. Dev env var missing. **Fix:** set in `.env`/compose or stop the container.
- **B-REPO-5 [Low] Stray tracked file `ts registry.npmjs.org`** — repo root; it is `less` help-screen output (accidental redirect), and it is git-tracked. **Fix:** `git rm`.
- **B-REPO-6 [Low] Lint residuals (ruff), not individually verified as exploitable** —
  - S608 string-built SQL: `auth-svc/app/service.py:327`, `integrations-svc/app/routes/internal.py:98,110,128,177` — confirm only constants are interpolated.
  - B904 re-raise without `from`: `integrations-svc/app/auth.py:101,116`, `routes/integrations.py:370`, `telemetry-svc/app/auth.py:107,125`, `routes/timeline.py:114,196`.
  - S110 swallowed exceptions: `auth-svc/app/routing/consumer.py:83-85`, `email-worker/app/presence.py:60-62`.
  - B007 unused loop var: `auth-svc/app/jobs/prune_refresh_tokens.py:88`.
  - RET503 missing explicit return: `integrations-svc/app/providers/oauth.py:209,239`.
  - F401 unused import: `integrations-svc/tests/integration/test_oauth_callback.py:10`.
  - B017 `pytest.raises(Exception)`: `auth-svc/tests/test_leave_org.py:133`, `tests/test_org_deletion.py:60`, `integrations-svc/tests/test_oauth_identity.py:60`.
- **B-REPO-7 [Low] `.github/` is empty and untracked** — no CI workflow in the tree (Jenkinsfile is the only pipeline); consistent with the earlier note that Actions never ran. Informational.
