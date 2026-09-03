# Auth/Authz Remediation Plan

Status: **planned, not yet implemented**. Written 2026-08-25, revised after two
technical review passes, against `auth-svc`, `task-svc`, `email-worker`,
`messaging-svc`, `ws-gateway`, `integrations-svc`, and the frontend at the
current state of this branch (post the
`services/shared/{crypto,kafka_security,tracing}` de-duplication refactor —
import paths below already reflect that, e.g. `from crypto import cryptor`
rather than `from ..crypto import cryptor`).

Confirmed scope for this pass:

- **MFA factors**: TOTP **and** WebAuthn/passkey, both built now.
- **MFA enforcement**: opt-in for everyone **and** an org-admin-mandatory
  policy, both built now.
- **Internal service secrets**: per-callee-service secrets now (not deferred).

**Revision 1** redesigned Item 1 (Kafka) from a topic-rename to a pull-based
design after review found the rename didn't remove the secret from a broker
with no ACL enforcement, and reordered phases into P0/P1/P2 by severity.

**Revision 2** (this version) fixes eleven further issues the second review
pass found: a phase-ordering bug where the Kafka redesign was sequenced
*before* the internal-secret mechanism it depends on; a Docker Compose
misunderstanding where `environment:` does not actually stop `env_file:`
from also injecting a secret; a missing enrollment path for an admin who is
blocked by the mandatory-MFA policy but has nothing to authenticate an
enrollment call with; a WebAuthn sign-count bug against authenticators that
never implement a counter; a non-atomic TOTP replay check; undefined
multi-org MFA semantics; missing response-hygiene on the new internal
endpoint; undifferentiated retryable-vs-permanent failure handling on that
same endpoint; a concurrency hole in the invite-supersede fix; unbounded
backup-code accumulation on regeneration; and an unstated (but, on
inspection, already-correct) trusted-proxy assumption for the new audit-log
IP field.

---

## Priority ordering

| # | Phase | Item(s) | Why here |
|---|---|---|---|
| P0 | 0 | CI wiring for the existing cross-org test | Zero-risk, makes every later phase self-checking as it lands |
| P0 | 1 | task-svc unscoped internal-delete fix | Item 8 — highest severity, self-contained, no dependency |
| P0 | 2 | Per-service internal secrets | Item 9 — foundational. **Corrected in this revision**: this must land *before* Phase 3, because Phase 3's new pull endpoint needs an internal-auth mechanism to already exist in order to guard it. The previous revision had these two reversed. |
| P0 | 3 | Kafka/outbox raw-token removal + mandatory token invalidation | Item 1 — the platform-wide secret-broadcast gap. Its new internal endpoint is guarded by Phase 2's already-landed secret — no chicken-and-egg between the endpoint and its own auth mechanism. |
| P1 | 4 | Email-verify auto-consume fix | Item 3 — mechanical, independent |
| P1 | 5 | Invite rate-limit + lockout wiring | Item 6 — mechanical, independent |
| P1 | 6 | Invite token superseding | Item 2 — mechanical, independent |
| P1 | 7 | MFA: TOTP + WebAuthn, opt-in + mandatory-for-admins | Item 4 — the largest single item. Deliberately last in P1 so it never delays the P0 severity fixes above; nothing in P0/P1 4-6 depends on it |
| P2 | 8 | Access-token TTL reduction | Item 5 — lowest urgency, config-only |
| P2 | 9 | Audit log IP/UA/request-id/session-id | Item 7 — hardening, not closing an active hole |
| P2 | 10 | Documentation reconciliation | Item 10, part 2 — written once, last, against the true end state |

Nothing here should require re-deriving context — a future session can pick
up any single phase independently using the file/function references below.

---

## Phase 0 — CI wiring for the existing cross-org test (Item 10, part 1)

**Why first**: `scripts/security-authz.ts` already exists, already self-seeds
two orgs, already asserts cross-org IDOR isolation across auth/task/messaging,
and already exits non-zero on failure. It requires zero code changes and is
referenced nowhere in CI.

- **File**: `.github/workflows/ci.yml`, `e2e` job (currently lines ~548-582).
  Add a step after the existing `npm run seed` step:
  ```yaml
  - name: Cross-org authorization regression
    run: npx tsx scripts/security-authz.ts
  ```
  No new env vars needed — `scripts/_tb.ts`'s default ports (`8001`/`8002`/`8004`)
  already match the `e2e` job's compose stack.
- **Bonus fix, same file**: line ~574 runs `npm run demo`, which does not exist
  as an npm script anywhere in the repo (confirmed by grep) — this step is
  presumably already red. Remove it or replace it with a real script.

**Explicit caveat — do not oversell this step.** This script proves **cross-org
data isolation** across auth/task/messaging. It proves nothing about:
- task-svc's internal by-title endpoint being properly org-scoped (Phase 1
  adds a dedicated regression test for that specific endpoint).
- internal-service-secret identity being enforced per callee (Phase 2 adds a
  dedicated test that a caller bearing service A's secret is rejected by
  service B).
- token single-use/lifecycle invariants — invalidate-on-mint, atomic consume,
  pull-based delivery (Phases 3 and 6 add dedicated tests for these).
- MFA correctness (Phase 7 adds dedicated tests).

Track CI coverage as a running checklist, not a single script:

| Property | Covered by |
|---|---|
| Cross-org IDOR isolation (auth/task/messaging) | `scripts/security-authz.ts` (this phase) |
| task-svc internal by-title org-scoping | New integration test, Phase 1 |
| Internal-service-secret identity per callee | New test, Phase 2 |
| Raw-secret-never-on-Kafka + pull-endpoint auth | New tests, Phase 3 |
| Invite invalidate-on-mint / concurrent-create / concurrent-accept | New tests, Phase 6 |
| MFA enrollment/challenge/lockout/policy | New tests, Phase 7 |

Doc corrections that depend on later phases are deferred to **Phase 10**.

---

## Phase 1 — task-svc: fix the unscoped internal delete endpoint (Item 8)

**Exact current bug** — `services/task-svc/app/routes/tasks_write.py:174-258`,
`DELETE /internal/tasks/by-title/{title}`:
- Line 193: `internal_token != settings.internal_token` — a plain `!=`, the
  only non-constant-time internal-token check platform-wide.
- No `org_id` parameter anywhere (path, query, or body).
- Line 197: unconditionally calls `set_bypass_rls(db)` — a mechanism
  `db.py:189-197` documents, in its own words, as "trusted server code ONLY —
  never driven by request input." This endpoint violates that by construction.
- When `username` is omitted: `SELECT id, org_id, title_enc FROM tasks` with
  **no WHERE clause at all** — decrypts every row platform-wide as a match
  candidate, then deletes every title-match across every org.
- When `username` is given: the `user_projection` lookup also has no org
  filter.

**Fix**:
- Make `org_id` a **required query parameter**. If absent, return
  `400 Bad Request` explicitly — never "query without the constraint."
- Replace `set_bypass_rls(db)` with `set_org_context(db, org_id)` — the exact
  mechanism this service's own public JWT-authenticated routes already use,
  so Postgres RLS itself enforces the boundary instead of the code trusting
  an unscoped bypass.
- Add `AND org_id = :org_id` to the `user_projection` lookup too, as
  defense-in-depth even with RLS active.
- Replace `internal_token != settings.internal_token` with a local
  `secrets.compare_digest(...)` call now; swap to Phase 2's shared
  `internal_auth` helper once that phase lands (either order is safe — this
  fix doesn't need to wait on Phase 2).
- **Test — dedicated, mandatory, not delegated to Phase 0's script**: this
  service's test suite is currently unit-only (no DB/Kafka/Redis touched
  anywhere today). Build an `httpx.AsyncClient` + real Postgres fixture
  harness (mirror auth-svc's `test_rls_isolation.py` fixture style, not its
  business logic). New test: create a task titled `"X"` in org A; call the
  endpoint with `org_id=B, title=X` → assert 404/no-op and the task in A
  still exists; call with `org_id=A, title=X` → assert it's deleted; call
  with `org_id` omitted → assert `400`, not a platform-wide scan.
- **CI**: add `task-svc` to `.github/workflows/ci.yml`'s `test-integration`
  job matrix (currently `[auth-svc, integrations-svc]` only) so this test
  actually runs.

---

## Phase 2 — Internal service-to-service secrets: per-callee-service (Item 9)

**Sequencing note**: this phase now lands *before* the Kafka redesign
(Phase 3), which was the reverse of the previous revision. Phase 3 introduces
a new internal endpoint that must be guarded by a real secret from day one —
building it before this phase existed would have meant either shipping it
unguarded temporarily or inventing a throwaway secret mechanism just to
replace it a phase later. Landing the secrets model first removes that
problem entirely.

**Real call graph** (verified against the actual code, not the illustrative
diagram in the original ask):

| Callee (validates a secret) | Confirmed caller(s) |
|---|---|
| auth-svc (`/internal/users/{id}`, `/internal/audit/verify/{org_id}`, `/internal/keys/rotate/{org_id}`, `/internal/users/reproject/{org_id}`) | email-worker calls `/internal/users/{id}` (`relay_consumer.py:620-622`) **and, after Phase 3, `/internal/outbox-events/{id}`**; the other 3 have no confirmed programmatic caller (likely ops/CLI-triggered) |
| task-svc (`/internal/tasks/by-title/{title}`) | no confirmed caller found (likely an ops/support tool) |
| messaging-svc (4 internal endpoints) | task-svc, ws-gateway's delivery component, integrations-svc, email-worker — **4 distinct callers** |
| ws-gateway (`/internal/push`) | its own delivery-svc component only (intra-service) |
| integrations-svc (`/internal/messages/send`, `/internal/mail/send`) | `/internal/messages/send` has no real caller anywhere (stale/aspirational — exclude from urgent scope, harden defensively regardless); `/internal/mail/send` is called by email-worker |
| notification-svc, graph-gw | never reference `TB_INTERNAL_TOKEN` today — pure unnecessary exposure via the shared env file |
| telemetry-svc | reads it into config and its prod-safety validator requires it non-empty, but no route ever checks it — dead required config |

- **New shared helper — Python**, following the exact convention this repo
  just established for `services/shared/{crypto,kafka_security,tracing}`:
  new package `services/shared/internal_auth/internal_auth.py` exposing one
  function, e.g. `require_internal_token(provided: str, expected: str) -> None`
  (raises `HTTPException(401)` via `secrets.compare_digest`), installed the
  same way as the other shared packages (`../shared/internal_auth` in each
  consuming service's `requirements.txt`, plus the matching `Dockerfile`
  `COPY services/shared/internal_auth ...` stanza). Used by
  `auth-svc/app/routes/internal.py` (including Phase 3's new endpoint),
  `task-svc/app/routes/tasks_write.py`, `integrations-svc/app/routes/internal.py`.
- **New shared helper — Go**, following the exact convention this repo just
  established for `services/shared/kafkaauth` (a Go module aliased as
  `github.com/task-board/shared-kafkaauth` via a `replace` directive in each
  consumer's `go.mod`): new module `services/shared/internalauth`, consumed
  the same way by `messaging-svc/internal/api/internal_delivery.go` and
  `ws-gateway/internal/server/push.go`.
- **New env vars, one per exposing service**, replacing the single
  `TB_INTERNAL_TOKEN`:
  - `AUTH_INTERNAL_TOKEN`
  - `TASK_INTERNAL_TOKEN`
  - `MESSAGING_INTERNAL_TOKEN`
  - `WS_GATEWAY_INTERNAL_TOKEN`
  - `INTEGRATIONS_INTERNAL_TOKEN`
  (notification-svc, graph-gw, telemetry-svc: remove the config field
  entirely rather than giving them a token nothing checks.)
- **Caller-side changes** — each caller's config/HTTP-client sends only the
  secrets of the services it actually calls:
  - email-worker needs `AUTH_INTERNAL_TOKEN`, `MESSAGING_INTERNAL_TOKEN`,
    `INTEGRATIONS_INTERNAL_TOKEN`.
  - task-svc needs `MESSAGING_INTERNAL_TOKEN`.
  - ws-gateway's delivery component needs `MESSAGING_INTERNAL_TOKEN` and its
    own `WS_GATEWAY_INTERNAL_TOKEN`.
  - integrations-svc needs `MESSAGING_INTERNAL_TOKEN`.
- **`docker-compose.prod.yml` / `.env.prod.example` restructuring — corrected
  in this revision.** The previous draft recommended giving each service its
  own `environment:` block "overriding the shared anchor per-service" and
  called that the smallest diff. That doesn't actually achieve isolation:
  Compose's `environment:` only **adds or overrides specific keys** on top of
  whatever `env_file:` already injects — it cannot **subtract** a key. As
  long as every service still carries `env_file: .env.prod` via the shared
  `x-svc-defaults` anchor, every secret in that file reaches every container
  regardless of any `environment:` block layered on top. Corrected design:
  1. Move the five internal-token secrets **out of `.env.prod`** entirely
     (including removing `TB_INTERNAL_TOKEN`) into a new file, e.g.
     `secrets.internal.prod`, that is **not referenced by any service's
     `env_file:`**. It's used only as a Compose variable-substitution
     source: `docker compose --env-file secrets.internal.prod --env-file
     .env.prod ...` (Compose supports multiple `--env-file` flags; values
     become available for `${VAR}` interpolation in the YAML but are **not**
     auto-injected into any container — only an explicit `environment:` or
     `env_file:` reference does that).
  2. `.env.prod` keeps every non-secret shared setting, referenced by the
     `x-svc-defaults` anchor exactly as today.
  3. Each service that needs one or more internal secrets gets an explicit
     `environment:` allowlist naming only those keys:
     ```yaml
     email-worker:
       env_file: .env.prod
       environment:
         AUTH_INTERNAL_TOKEN: ${AUTH_INTERNAL_TOKEN}
         MESSAGING_INTERNAL_TOKEN: ${MESSAGING_INTERNAL_TOKEN}
         INTEGRATIONS_INTERNAL_TOKEN: ${INTEGRATIONS_INTERNAL_TOKEN}
     ```
  4. notification-svc, graph-gw, and telemetry-svc get **no** `environment:`
     entry naming any of the five keys — since nothing in their service
     definition references them, they never receive them. This is the actual
     isolation guarantee; inspecting the YAML alone doesn't prove it (see
     Test, below).
- **Rotation runbook note** (Phase 10): rotating one service's secret now
  only requires redeploying that service plus its actual callers.
- **Explicitly out of scope**: mTLS / workload identity — documented future
  step (Phase 10), not built now.
- **Test**: for each exposing service, a request bearing another service's
  secret is rejected (401); a request bearing its own is accepted. Add a
  **deploy-time verification step** — `docker compose config` (resolves the
  merged environment Compose would actually set) or `docker exec <container>
  env` against a running container — confirming notification-svc/graph-gw/
  telemetry-svc's actual containers carry none of the five `*_INTERNAL_TOKEN`
  vars. Given the `env_file`+`environment` merge behavior above, this must be
  verified against the resolved runtime environment, not just read off the
  YAML.

**Addendum (2026-09-03) — per-service isolation reverted.** What actually
shipped for this phase was the simpler variant sketched earlier in this
section, not the `secrets.internal.prod` + `environment:` allowlist design
above: six separate gitignored files at the repo root
(`.env.prod.<callee>-internal-token`, one per exposing service — including
`sticky-internal-token`, added later for sticky-svc and never folded back
into this doc), each layered onto `.env.prod` only via the `env_file:` list
of the services that actually called that callee.

At explicit request, this was collapsed back into a single `.env.prod`
carrying all six `*_INTERNAL_TOKEN` values, with every application service
(notification-svc, graph-gw and telemetry-svc included) now receiving all
six via the shared `x-svc-defaults` anchor. **The isolation this phase
built — a compromised service, or a leaked env file, handing out only its
own credential rather than every internal endpoint's — no longer holds.**
Rotating any one token now means redeploying every service, not just its
actual callers. Separately: the six formerly-separate token values were
inadvertently printed into a terminal/log during this merge (2026-09-03) and
must be rotated (`openssl rand -hex 32` each) — as of this writing that
rotation has NOT been confirmed done; do not assume it has been. Re-establishing
the isolation would mean implementing the `environment:`-allowlist design
actually described above, not just re-adding the files. (This doc's other
comments reference a Helm chart at `deploy/helm/taskboard/` as an existing
deployment path with its own per-secret mounts — no such directory exists in
this repository, so that is not currently a fallback either.)

---

## Phase 3 — Kafka: raw secrets never touch the broker (Item 1, redesigned)

**Why the first draft was insufficient**: renaming the topic
(`auth.events` → `auth.secrets`) reduces which consumer *groups* subscribe,
but the Kafka broker in this repo has **no ACL enforcement configured
today** — confirmed, no `infra/kafka/` ACL config or broker-level principal
restriction exists anywhere. A topic name is not a security boundary on a
broker anyone with network access can read from. The fix has to remove the
secret from the bus entirely, not just relabel which bus it's on.

**Constraint that shaped the redesign**: `email-worker` has **no HTTP
server** — it's a pure Kafka consumer process ("no web server, no port," per
its own module docstring in `worker.py`). Building one just for this would be
a disproportionate infrastructure change. It **does** already act as an HTTP
*client* to auth-svc today (`relay_consumer.py:620-622` calls
`/internal/users/{id}`), so a **pull** design — email-worker calling out to
auth-svc — costs nothing new on that front and reuses the exact internal-auth
edge (and secret) Phase 2 already gives it.

**Also constraining the design**: `_mint_token` (`account_service.py:35-66`)
deliberately never persists the raw token — only its SHA-256 hash. The raw
value exists in memory only for the duration of the mint call. Today it's
captured once into the `outbox.payload` JSON (via `build_event`'s `resetUrl`/
`verifyUrl`/`inviteUrl` kwargs, `outbox.py:20-31`) — that's the only place the
raw secret is ever stored. This doesn't need to change (it isn't the leak);
what needs to change is **what leaves this row and reaches Kafka.**

### The redesign

1. **`build_event`/`enqueue_event`/the three call sites are unchanged** —
   `account_service.py:156-164`, `account_service.py:215-223`,
   `invites_service.py:108-118` keep building the full event (including the
   raw URL) and inserting it into `outbox` exactly as today. The secret still
   only ever lives in Postgres, which is already the source of truth and
   already access-controlled by the DB layer.
2. **`poller.py`'s `_drain_once` (lines ~119-238) gains a small per-type
   redaction step immediately before `producer.send_and_wait`**: for exactly
   the three event types `password.reset.requested`,
   `email.verification.requested`, `invite.created`, build a copy of the
   payload with `resetUrl`/`verifyUrl`/`inviteUrl` stripped and
   `"outboxId": str(row.id)` added, and publish *that* to Kafka instead of
   the raw `row.payload`. Every other event type publishes unchanged.
3. **New auth-svc internal endpoint**, `GET /internal/outbox-events/{outbox_id}`,
   guarded by Phase 2's `AUTH_INTERNAL_TOKEN` (email-worker already needs
   this secret for its existing `/internal/users/{id}` call — no new
   secret, no new edge in the call graph, and it already exists by the time
   this phase lands). Looks up `outbox` by primary key, `WHERE
   payload->>'type' IN ('password.reset.requested',
   'email.verification.requested', 'invite.created')` (this allow-list is
   load-bearing: it stops the endpoint being usable as a generic
   outbox-payload-leak oracle for unrelated event types).
   - **Response hygiene**: set `Cache-Control: no-store` on every response so
     no intermediate proxy/cache retains the raw secret. Confirm the
     service's existing structured-logging/access-log middleware does not
     log response bodies for this route — check against whatever pattern
     already redacts/skips bodies elsewhere in this service rather than
     assuming. Confirm the existing `opentelemetry-instrumentation-fastapi`/
     `httpx` setup is not configured to capture request/response bodies as
     span attributes for this route (it typically isn't, by default — verify
     rather than assume, and add an explicit exclusion if it is).
   - **Retryable vs. permanent failure — this distinction matters for
     email-worker's dispatch logic.** A `404` from this endpoint (row not
     found, wrong event type, or already past its `expiresAt` and redacted —
     see point 5 below) is a **permanent** outcome: there is nothing useful
     to retry, since an expired/redacted link can't be delivered meaningfully
     anyway (consistent with the existing single-use-token security posture:
     no oracle, no special-cased error per failure reason). email-worker's
     dispatch must treat a 404 here as "permanently undeliverable": log a
     warning and still commit the Kafka offset, rather than leaving the
     offset uncommitted and looping on redelivery forever. Any other failure
     (connection refused, 5xx, timeout) is **transient** — don't commit the
     offset, let Kafka's existing redelivery retry it, exactly as today's
     dispatch already does for other failures.
4. **email-worker's dispatch** (`worker.py`, the three `_HANDLED_TYPES`
   branches): on receiving one of these events, call the new endpoint with
   `event["outboxId"]` to fetch the actual delivery URL, then proceed exactly
   as today (render template, SMTP send, write the `email_consumed` dedup
   row, commit the Kafka offset only after that succeeds — see the
   retryable-vs-permanent handling above).
5. **Redaction of the stored row**: don't wait for the existing outbox
   prune job's full retention window (multi-day). Extend whatever job
   already owns outbox-row lifecycle (or add a small periodic sweep using the
   same connection/engine pattern as the poller) to null out
   `resetUrl`/`verifyUrl`/`inviteUrl` from these three event types' payload
   once `now() > (payload->>'expiresAt')::timestamptz` — a field already
   present on every one of these three events.
6. **`TOPIC_AUTH_SECRETS` is dropped** — there's no longer a reason to
   segregate topics, since nothing sensitive is published to either one.

### Mandatory one-time remediation for already-exposed tokens

This is a **required deployment step for this phase, not an optional
follow-up script**. Sequenced strictly *after* the code above ships, and
*before* any Kafka-ACL infra follow-up: run a one-time ops migration that
expires every currently-`pending` row in `user_tokens` (both purposes) and
every currently-`pending` row in `invites`. Document this in the deploy
runbook as a required step.

### Kafka ACLs — now lower-stakes, still an open follow-up

Because the raw secret no longer transits Kafka at all, the absence of
broker-level ACLs is no longer a live exposure path *for this specific
vulnerability*. Still worth doing for defense-in-depth against future event
types — tracked in "Open follow-ups" below.

### Tests

- Assert the Kafka-published payload for these three event types never
  contains `resetUrl`/`verifyUrl`/`inviteUrl` — only `outboxId` plus
  non-secret fields.
- Assert `GET /internal/outbox-events/{id}` requires a valid
  `AUTH_INTERNAL_TOKEN` (401 without it), 404s for any event type outside
  the three-item allow-list, and responds with `Cache-Control: no-store`.
- Assert a 404 (expired/redacted/wrong-type) does **not** block the Kafka
  offset from committing (permanent-skip path); assert a simulated
  connection failure / 5xx **does** leave the offset uncommitted (retry
  path).
- Assert email-worker still successfully sends using the fetched URL.
- Assert the stored row's URL fields are nulled once `expiresAt` passes, even
  when never fetched.

---

## Phase 4 — Email-verify: stop auto-consuming the token on page load (Item 3)

Current bug: `packages/app/src/routes/VerifyEmail.tsx:18-25` fires the
**consuming** `POST /auth/email/verify` from a bare `useEffect` on mount — no
user gesture, so an email client's link-preview/scanner bot can burn the
token before the real user clicks it. `ResetPassword.tsx` and
`InviteAccept.tsx` already do this correctly: a read-only peek on mount, then
an explicit button/form submit fires the consuming call. The token staying in
the URL is fine and unchanged — only the auto-consumption is the bug.

- **Backend**: add one route to the existing
  `services/auth-svc/app/routes/email_verify.py`:
  ```
  GET /auth/email/verify/peek?token=...
  ```
  calling the already-generic `peek_token_valid(conn, PURPOSE_VERIFY, token)`
  from `account_service.py:99-114` (already powers the reset peek — zero new
  backend logic). Needs `await service.set_bypass_rls(conn)` first, same as
  the existing `verify_email` route.
- **Rate limit** — must never consume, must never be unrestricted: add to
  `_SENSITIVE_LIMITS` in `services/auth-svc/app/rate_limit.py`
  (currently lines 93-105):
  ```python
  ("GET", "/auth/email/verify/peek"): (10, 60),
  ```
- **Frontend**: rewrite `VerifyEmail.tsx` to mirror `ResetPassword.tsx`:
  peek on mount → render "Confirm your email" button → call
  `api.verifyEmail(token)` only from the button's `onClick`. Reuse
  `AuthLayout` exactly as it already does.
- **Test**: backend test for the new peek route (valid token → true,
  expired/consumed/garbage → false, **never consumes**); frontend test
  mirroring whatever pattern already covers `ResetPassword`/`InviteAccept`.

---

## Phase 5 — Rate-limit invite endpoints + wire invite password-check into lockout (Item 6)

Current: `_SENSITIVE_LIMITS` has no entry for either invite route, so both
fall back to the generic 120/min global limit. `accept_invite_tx`'s
password-check branch (`invites_service.py:214-219`, when the invite's email
already has an identity) has zero failed-attempt tracking.

- **Promote the lockout helper first** (also needed by Phase 7/MFA — do it
  once here): `_register_failed_login` is currently private and module-local
  inside `services/auth-svc/app/routes/auth.py:46-66`. Move it to
  `service.py` alongside the existing `reset_identity_lockout`
  (`service.py:688-694`), e.g. `service.register_failed_login(conn,
  identity_id) -> None`. Update `auth.py`'s `login()` (its inlined lockout
  check around lines 270-278) to call the promoted version. Pure extraction,
  no behavior change for login.
- **Wire it into invite-accept**: in `invites_service.py`'s
  `accept_invite_tx`, around lines 215-219, call
  `service.register_failed_login(conn, existing_ident.id)` on a failed
  password check before raising 401, and check `locked_until` before
  attempting the password verify at all.
- **Rate limits** — add to `_SENSITIVE_LIMITS`:
  ```python
  ("POST", "/auth/invites/accept"): (10, 60),   # matches /auth/login — gates a password guess
  ("GET",  "/auth/invites/verify"): (10, 60),   # peek endpoint, same budget as email-verify peek
  ```
- **Test**: repeated wrong-password invite-accept attempts trip the same
  `locked_until` mechanism login already has; rate-limit tests analogous to
  existing `/auth/login` rate-limit tests.

---

## Phase 6 — Invite tokens: invalidate prior pending invite on mint (Item 2)

Current: `account_service.py`'s `_mint_token`/`_consume_token`
(lines 35-96) already give password-reset and email-verify both guarantees
the user asked for — invalidate-prior-on-mint AND atomic
`SELECT...FOR UPDATE` consume. `invites_service.py`'s
`create_invite_tx`/`accept_invite_tx` is a separate implementation against
the `invites` table (own schema: `status`/`accepted_at`/`accepted_user_id`,
no `used_at`). `accept_invite_tx` (lines 178-193) **already** does
`SELECT...FOR UPDATE` correctly — no race condition exists there today. The
only real gap: multiple simultaneously-valid invite links can exist for the
same `(org_id, email)`, since `create_invite_tx` never invalidates a prior
pending invite before minting a new one.

- **Fix, in `create_invite_tx`, before the `INSERT INTO invites`**:
  ```sql
  UPDATE invites SET status = 'superseded'
  WHERE org_id = :org AND email = :email AND status = 'pending'
  ```
  No CHECK-constraint migration needed for the new status value —
  `invites.status` has none (`0001_init.sql:55-67`).
- **Concurrency gap in this fix itself.** The invalidate-then-insert
  sequence above is not safe against two truly concurrent
  `create_invite_tx` calls for the same `(org_id, email)` — under READ
  COMMITTED, a concurrent transaction B's `UPDATE ... WHERE status='pending'`
  cannot see transaction A's not-yet-committed `INSERT`, so both can
  independently supersede whatever was *already* pending before either
  started, then both insert — leaving two simultaneously-pending invites for
  the same pair. That's the exact bug this phase exists to close, just moved
  into the concurrent case. **Fix — a migration is needed after all**:
  ```sql
  -- 0015_invite_pending_uniqueness.sql (shipped as 0015 — 0014 was already
  -- taken by an unrelated concurrent avatar migration by the time this landed)
  CREATE UNIQUE INDEX idx_invites_org_email_pending
      ON invites (org_id, email) WHERE status = 'pending';
  ```
  With this partial unique index in place, the second concurrent `INSERT`
  raises a unique-violation. `create_invite_tx` catches that specific
  constraint error and retries the supersede-then-insert sequence once (now
  correctly seeing the first invite as pending and superseding it) instead of
  surfacing a generic 500.
- **No change needed to the routing-directory placement logic** — an old
  token's directory entry may still resolve to a site, but
  `accept_invite_tx`'s own DB status check is authoritative and already
  rejects it.
- **Consolidation call**: don't unify `invites` and `user_tokens` into one
  shared table/helper despite the "sibling template" docstring — different
  schemas and lifecycle needs (cross-site routing directory bolted onto
  invites only); this fix stays minimal and targeted.
- **Test**: create invite A, create invite B for the same `(org, email)`,
  assert A flips to `superseded` and now 400s on accept; B still succeeds.
  Sequential-race regression test locking in the existing `FOR UPDATE`
  behavior on accept. **New concurrency test**: fire two genuinely
  simultaneous `create_invite_tx` calls for the same `(org, email)` and
  assert exactly one invite ends up `pending` afterward, not two.

---

## Phase 7 — MFA: TOTP + WebAuthn, opt-in + org-admin-mandatory (Item 4)

Largest single item — deliberately last in P1 so nothing here delays the P0
severity fixes above. Split across several new files rather than one large
`mfa.py`, given the ceremony logic for TOTP vs. WebAuthn is genuinely
distinct.

### Storage location: `users`, not `identities`

`identities` (`migrations/0007_identities.sql:16-25`) is deliberately
cross-org with no per-identity encryption mechanism today. `users` already
has the only existing encrypted-column convention (`email_enc`/`email_bidx`,
`migrations/0002_column_encryption.sql:18-29`) via the shared `Cryptor`
class, which is strictly per-org (`org_id` is the AAD). Since "mandatory for
admins" is inherently an org-role policy, and reusing `Cryptor` needs zero new
crypto plumbing, **store MFA state per org-membership on `users`**. Accepted
consequence: a user with two org memberships enrolls TOTP/WebAuthn twice.

### Schema — new migration `0016_mfa.sql` (shipped as 0016 — Phase 6 shipped as `0015`)

```sql
ALTER TABLE users
    ADD COLUMN mfa_totp_secret_enc   bytea,
    ADD COLUMN mfa_totp_last_counter bigint,   -- distinct field, distinct meaning: the
                                                -- last successfully-consumed 30s time-step,
                                                -- NOT reused from mfa_enrolled_at
    ADD COLUMN mfa_enrolled          boolean NOT NULL DEFAULT false,
    ADD COLUMN mfa_enrolled_at       timestamptz;

ALTER TABLE orgs
    ADD COLUMN require_mfa_for_admins   boolean NOT NULL DEFAULT false,
    ADD COLUMN mfa_grace_period_ends_at timestamptz;  -- set when the policy is toggled on

CREATE TABLE mfa_backup_codes (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id),
    org_id     uuid NOT NULL,
    code_hash  bytea UNIQUE NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_webauthn_credentials (
    id             uuid PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES users(id),
    org_id         uuid NOT NULL,
    credential_id  bytea UNIQUE NOT NULL,
    public_key     bytea NOT NULL,
    sign_count     bigint NOT NULL DEFAULT 0,
    nickname       text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_used_at   timestamptz
);
```
Both new tables get RLS policies mirroring `user_tokens`'s existing
org-scoped policy (`migrations/0003_rls.sql` is the reference pattern).
Backup codes reuse the exact `_consume_token`-style
`SELECT...FOR UPDATE` single-use pattern.

**TOTP replay check must be atomic.** The check-then-update of
`mfa_totp_last_counter` (is this time-step greater than the stored value; if
so, accept it and store it) must happen under row-level locking, mirroring
`_consume_token`'s `SELECT ... FOR UPDATE` pattern:
`SELECT mfa_totp_last_counter FROM users WHERE id = :uid FOR UPDATE`, compare,
then `UPDATE`, all in one transaction. Without this, two concurrent requests
replaying the same captured code in parallel could both pass the comparison
before either commits — defeating the anti-replay guarantee under a race,
not just against a naive sequential replay.

### New dependencies

- `pyotp` (RFC 6238 TOTP) — nothing in `requirements.txt` covers this today.
- `webauthn` (Duo Labs' Python WebAuthn library) for relying-party
  registration/assertion verification. Client side needs no new
  dependency — the browser's native `navigator.credentials.create`/`.get`
  WebAuthn API is used directly.
- QR rendering for the TOTP `otpauth://` URI: reuse an existing transitive
  frontend dependency if one already covers it before adding a new package.

### New backend files

- `services/auth-svc/app/routes/mfa_totp.py` — enroll-start (generate
  secret, return `otpauth://` URI, don't persist yet), enroll-confirm
  (verify a code against the pending secret, flip `mfa_enrolled`, persist
  `mfa_totp_secret_enc` via `cryptor().encrypt(conn, org_id, secret)`,
  generate + return backup codes once).
  - **Backup-code regeneration** — a `POST /auth/mfa/backup-codes/regenerate`
    endpoint requiring the same step-up auth as MFA-disable (password + a
    valid current second factor). Within one transaction, it must invalidate
    every existing unused row in `mfa_backup_codes` for this user
    (`UPDATE mfa_backup_codes SET used_at = now() WHERE user_id = :uid AND
    used_at IS NULL`) **before** inserting the new batch — otherwise old
    codes remain valid indefinitely alongside new ones, silently
    accumulating extra valid bypass credentials every time someone
    regenerates.
- `services/auth-svc/app/routes/mfa_webauthn.py` — registration-start/finish,
  authentication-start/finish. Challenge storage: short-lived, in the same
  "MFA pending" mechanism used for login (below).
  **Explicit acceptance criteria for every assertion verified** (make these
  checks, don't just check sign-count):
  - challenge is fresh and single-use (matches a challenge this server
    issued, not previously consumed);
  - origin matches the configured RP origin exactly;
  - RP ID matches;
  - credential ID resolves to a stored `mfa_webauthn_credentials` row for
    this user;
  - signature verifies against that row's stored public key;
  - user-presence (UP) flag is set, and user-verification (UV) flag is set
    when the org/policy requires UV;
  - `sign_count` is strictly greater than the stored value (anti-clone) —
    **except** when both the stored value and the assertion's value are `0`:
    some authenticators (notably several platform/Touch ID/Face ID
    implementations) never implement a signature counter and permanently
    report `0`. Treat stored-zero-and-assertion-zero as "counter not
    supported by this authenticator" and skip the monotonic check for that
    credential, rather than flagging every subsequent login as a clone.
- `services/auth-svc/app/routes/mfa_challenge.py` — the login-time
  challenge-verify endpoint (accepts the pending token + TOTP code /
  WebAuthn assertion / backup code; on success, mints the real session using
  the existing successful-login tail code — reuse `service.build_session`,
  don't duplicate it) and MFA-disable (requires re-entering password + a
  valid second factor as step-up auth).
- Apply `enforce_origin` (CSRF) only on `mfa_challenge.py`'s challenge-verify
  route (it sets the refresh cookie) — not on the bearer-only enroll/disable
  endpoints, matching the existing convention.

### Login-flow change

After password verification succeeds in `auth.py`'s `login()`: if the user
has MFA enrolled, or the org's `require_mfa_for_admins` applies to this user
and the grace period (below) has expired, do **not** immediately mint
access+refresh tokens. Instead:

- Mint a short-lived (~5 min) "MFA pending" token, reusing `user_tokens` with
  a new `purpose = "mfa_pending"` value and the existing
  `_mint_token`/`_consume_token` machinery — this purpose is created and
  consumed entirely server-side (never emailed), so it fits the existing
  table's shape with no new columns.
- Return it to the client instead of a session; the client calls
  `mfa_challenge.py`'s verify endpoint next.

**Restricted enrollment credential — how a blocked admin actually reaches
enrollment.** Blocking login at the password step (post-grace-period,
unenrolled) is only correct if there's a defined way for that admin to
authenticate to the enroll-start/enroll-confirm endpoints without a full
session — otherwise they're simply locked out with no path forward. Fix: the
same short-lived "MFA pending" token minted at the password-check step
(originally designed only to gate `mfa_challenge.py`'s verify endpoint) is
**also** accepted by `mfa_totp.py`/`mfa_webauthn.py`'s enroll-start/
enroll-confirm endpoints whenever that user's `mfa_enrolled` is false — this
is the only way those endpoints can be reached pre-session, and it's scoped
to exactly the one `user_id` the pending token was minted for. Once
enrollment completes (enroll-confirm succeeds), consume the same pending
token to mint the real session directly, rather than forcing a second round
trip through challenge-verify.

**Mandatory-admin rollout — grace period, not a pre-enrollment gate.**
Toggling `require_mfa_for_admins` to true sets `mfa_grace_period_ends_at`
(default 14 days out, configurable). During the grace window, non-enrolled
admins can still log in normally but see a persistent "You must enable MFA
by `<date>`" banner — reuse the exact existing `VerifyEmailBanner` pattern in
`packages/app/src/routes/AppShell.tsx:132-167` for a new `MfaRequiredBanner`.
After the deadline, an unenrolled admin's login is blocked at the password
step and routed straight into the enrollment flow (via the restricted
enrollment credential above) instead of getting a session.

**Which org's policy applies, for a multi-org user.** MFA enrollment state
and `require_mfa_for_admins` live per org-membership on `users`, but one
person can hold several memberships under a single `identities` row. The
check in `login()` evaluates exactly the org membership `login()` already
selects to build the initial session (whatever that existing
default-selection rule is) — never evaluated across all of a person's
memberships at once. `switch_org` (`auth.py`) must run the identical
mandatory-policy check when pivoting into a different membership: a user who
is fully enrolled and clear in org A can still be blocked switching into org
B if B has the mandatory policy active past its grace period and they've
never enrolled under that specific membership — MFA enrollment does not
carry across org boundaries, consistent with the per-org-membership storage
decision above.

- **Org settings endpoint**: `services/auth-svc/app/routes/org_lifecycle.py`
  already has the router (`prefix="/auth/org"`) and an existing
  settings-style POST (line ~173) — extend that same pattern with the
  `require_mfa_for_admins` toggle (setting `mfa_grace_period_ends_at` as a
  side effect) rather than adding a new router.

### Reused pieces (don't duplicate)

- `service.register_failed_login` (promoted in Phase 5) — reused for
  TOTP-verify and backup-code attempts.
- `service.write_audit` — new actions `mfa.totp_enrolled`,
  `mfa.webauthn_enrolled`, `mfa.disabled`, `mfa.challenge_failed`,
  `mfa.backup_code_used`, `mfa.backup_codes_regenerated`. No change to
  `_audit_entry_hash`.
- `_SENSITIVE_LIMITS` — add MFA challenge-verify and TOTP-verify at a budget
  matching `/auth/login`'s `(10, 60)`, tied into the same lockout function.
- `cryptor()` — same per-org encrypt/decrypt already used for `email_enc`,
  applied to `mfa_totp_secret_enc`.

### Frontend

- Settings page: TOTP enroll (show `otpauth://` URI as text + QR), WebAuthn
  enroll (native browser API, no library), backup-codes-shown-once page, and
  a "regenerate backup codes" action (step-up auth, warns that old codes
  stop working immediately).
- Login-time MFA challenge page: code input, "use a passkey" button, "use a
  backup code" link.
- Org-admin settings: `require_mfa_for_admins` toggle + grace-period display,
  extending the existing org-lifecycle settings UI.
- `MfaRequiredBanner` (new, mirrors `VerifyEmailBanner`).

### Tests

Enrollment (TOTP + WebAuthn — WebAuthn ceremony testing will likely need a
mocked authenticator/test vector, since a real browser ceremony can't run in
a backend test; say so plainly rather than skipping coverage silently), TOTP
verify (correct code, expired/replayed code via `mfa_totp_last_counter`
**including a concurrent-replay test proving the `FOR UPDATE` lock actually
serializes it**, time-skew tolerance), the full WebAuthn acceptance-criteria
checklist above **including a zero-counter authenticator that must not be
flagged as cloned**, backup-code single-use consumption, backup-code
regeneration invalidating all prior unused codes, lockout integration, the
restricted-enrollment-credential path (an admin blocked post-grace-period can
still reach enroll-start/enroll-confirm using only the MFA-pending token, and
nothing else), the grace-period rollout (policy on with zero enrolled admins
→ no immediate lockout → banner shown → still-unenrolled admin blocked only
after the deadline passes), the multi-org policy-evaluation case (`switch_org`
into a mandatory-and-unenrolled org blocks even when the source org was
clear), audit event coverage, and a full opt-in-enrolled-user login
round-trip end to end.

---

## Phase 8 — Access-token TTL reduction (Item 5)

Current: `verify_bearer` (`auth-svc/app/security/auth_dep.py:161-206`) is
purely stateless — no denylist check — and `jwt_access_ttl_seconds` defaults
to 900s. Chosen approach (over a cross-service Redis denylist, given every
service that verifies JWTs would otherwise need its own revocation check):
shorten the TTL and rely on refresh-family revocation.

- **Change**: reduce the default `jwt_access_ttl_seconds` in
  `services/auth-svc/app/config.py` from 900 to **300** (5 minutes).
  Config-only, no new code path.
- **No other code changes.** Refresh-token-family revocation on
  logout/reset already works correctly and is unaffected.
- **Documentation wording — be precise, this goes into Phase 10**: never
  write "logout revokes the access JWT," because it doesn't. The accurate
  statement is: **"Logout revokes the refresh-token family. Access tokens are
  short-lived (5 minutes) and may remain valid until they expire, even after
  logout."** Use this exact framing everywhere this is documented.
- **Test**: verify the new TTL doesn't break any hardcoded-900 assumption in
  tests (`grep -rn "900" services/auth-svc/tests`).

---

## Phase 9 — Audit log: add IP/UA/request-id/session-id (Item 7)

**Current state**: `_audit_entry_hash` (`service.py:747-759`) hashes exactly
six fixed positional fields (`org_id, actor_id, action, target, meta_json,
at`) — it does not hash the whole row. `write_audit`'s existing `meta: dict`
parameter is already one of those six hashed fields.

- **Design decision**: add the new fields into the existing `meta` dict, not
  as new bare columns — a new bare column would be absent on every
  historical row and `verify_audit_chain` recomputes with one fixed
  signature, so mixing "rows with a 7th column" and "rows without" would
  break re-verification. Routing through `meta` sidesteps this entirely — no
  migration needed.
- **Hard constraint**: never put passwords, raw tokens, or JWTs into this
  `meta` data — only `ip`, `userAgent`, `requestId`, `sessionId`.
- **Plumbing**: `auth.py`'s `login`/`logout`/`switch_org`;
  `password_reset.py`'s `forgot_password`/`reset_password`;
  `email_verify.py`'s `verify_email`/`resend_verification` all need a
  `Request` param added (`invites.py`'s `accept_invite` already has one —
  reuse it).
- **IP/UA — trusted-proxy model is inherited, not re-derived.** Reuse
  `client_ip(request)` from `app/net.py` exactly as-is. This function already
  implements a correct trust model (verified by reading it directly): it
  reads `X-Forwarded-For` right-indexed by `settings.trusted_proxy_hops`
  (default 1, matching the single Caddy edge hop this platform actually has)
  rather than trusting the client-supplied leftmost entry, and fails safe to
  the immediate peer IP if the header is absent or shorter than expected.
  This phase must call this exact function for the audit-log `ip` field — do
  not add a second IP-extraction path, and do not treat this new call site as
  license to relax `TRUSTED_PROXY_HOPS`. If a second proxy hop (e.g. a cloud
  load balancer in front of Caddy) is ever added to the deployment topology,
  `TRUSTED_PROXY_HOPS` must be raised platform-wide at that time — a
  pre-existing deployment-topology dependency `net.py`'s own docstring
  already documents, not a new gap introduced by this phase. `user_agent =
  request.headers.get("user-agent")`.
- **Request ID**: `rate_limit.py`'s `rate_limit_handler` already reads
  `request.headers.get("x-request-id")` — read the same way here rather
  than inventing a second mechanism.
- **Session ID**: use the refresh-token family id already generated at
  session creation (`service.build_session`).
- **Where the calls live**: `session_events.py`'s
  `session_started`/`session_ended`/`org_switched`/`login_failed` — thread
  `ip`/`user_agent`/`request_id`/`session_id` through these signatures.
- **Test**: assert a login's `meta_json` contains `ip`/`userAgent`/
  `requestId`/`sessionId` and never `password`/`token`/anything matching a
  JWT shape; assert `verify_audit_chain` still passes on a mixed history of
  old and new rows.

---

## Phase 10 — Final documentation reconciliation (Item 10, part 2)

Do this last, once Phases 0-9 have actually shipped.

- `docs/THREAT_MODEL.md:178-186` says the Go internal-token check is
  "Resolved" while `:333-336`'s own "top residual risks" list still calls it
  broken — fix this self-contradiction regardless of when Phase 2 lands.
- `docs/THREAT_MODEL.md:117-118,326-328` and
  `docs/COMPLIANCE.md:32,101-104,151-152`: describe the new per-service-secret
  model (Phase 2, including the corrected env-isolation approach) instead of
  the single shared `TB_INTERNAL_TOKEN`, and the new pull-based,
  never-on-Kafka token-delivery design (Phase 3).
- Update any claim implying `scripts/security-authz.ts` already runs in CI
  or that it alone proves authz is covered — reference the Phase 0 coverage
  table instead.
- Document the access-token TTL/logout wording exactly as specified in
  Phase 8.
- Note MFA's existence, its grace-period rollout mechanic, and the new
  access-token TTL in whichever doc describes the session model.
- Note mTLS/workload identity and Kafka ACLs as explicit documented future
  steps (not built in this pass).

---

## Open follow-ups to flag back to stakeholders (not solved by this plan)

1. **Kafka ACLs**: no ACL enforcement exists on the broker today. No longer a
   live exposure path for the specific vulnerability in Item 1 (Phase 3
   removes the secret from the bus entirely), but still worth doing for
   defense-in-depth against future event types.
2. **mTLS / workload identity**: deferred by explicit choice — per-service
   secrets are this pass's ceiling, not the end state.
3. Several internal endpoints have no confirmed caller anywhere in the
   codebase (auth-svc's 3 non-`/internal/users/{id}` routes, task-svc's
   by-title route, integrations-svc's `/internal/messages/send`) — worth
   confirming with whoever owns ops tooling whether they're still needed,
   independent of the secret-redesign work.

## Migrations added by this plan

- `0015_invite_pending_uniqueness.sql` (Phase 6): partial unique index
  `invites (org_id, email) WHERE status = 'pending'`.
- `0016_mfa.sql` (Phase 7): `users` MFA columns (including
  `mfa_totp_last_counter`), `orgs.require_mfa_for_admins` +
  `orgs.mfa_grace_period_ends_at`, `mfa_backup_codes`,
  `mfa_webauthn_credentials` + RLS policies.

No other phase requires a schema migration — Phase 3's redesign is
deliberately schema-free (it reuses `outbox.id` and the payload's own
`expiresAt` field). Items 3 (secrets), 5, 6 (rate limits), 7, 10 are pure
application/config/infra-layer changes; Phase 6 (Item 2) picked up a
migration in this revision for the concurrency fix.

## New dependencies added by this plan

- `pyotp` (Phase 7, TOTP)
- `webauthn` (Phase 7, WebAuthn relying-party logic)
- A frontend QR-rendering approach (Phase 7) — reuse an existing transitive
  dependency if one already covers it, before adding a new package.
