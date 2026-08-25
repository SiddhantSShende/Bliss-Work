# Compliance Control Matrix (SOC 2 / ISO 27001)

Auditor-facing mapping of control areas to their **concrete implementation** in
this repository and the **evidence** an assessor can inspect. This is the
machine-checkable companion to [`SECURITY.md`](./SECURITY.md) (control
narrative), [`THREAT_MODEL.md`](./THREAT_MODEL.md) (STRIDE per trust boundary),
and [`OPERATIONS.md`](./OPERATIONS.md) (runbooks).

Trust Services Criteria (TSC) and ISO 27001:2022 Annex A references are
indicative, for orientation during an audit — they are not a certification
claim.

## How to read this

- **Implementation** — where the control actually lives in code/config.
- **Evidence** — the artifact an auditor opens to confirm it: a migration, a
  test, a CI workflow run, or a config file.
- Paths are repo-relative. "CI run" means the corresponding GitHub Actions job in
  `.github/workflows/`.

---

## 1. Access control & authorization (SOC 2 CC6.1–CC6.3 / ISO A.5.15, A.8.2, A.8.3)

| Control | Implementation | Evidence |
|---|---|---|
| Authenticated identity from verified tokens only | EdDSA Bearer JWT verified against JWKS; `org_id`/`roles` read from **verified claims, never headers** | `services/auth-svc/app/security/auth_dep.py::get_principal` |
| Role-based admin gating | `require_org_admin` dependency on admin routes | `services/auth-svc/app/security/auth_dep.py::require_org_admin` |
| Per-org isolation (app layer) | Every query scoped by `org_id` from the token | `scripts/security-authz.ts` (cross-org IDOR suite) |
| Per-org isolation (DB backstop) | Postgres **RLS ENABLE + FORCE** on every org-bearing table; fail-closed on unset GUC | `services/auth-svc/migrations/0003_rls.sql`, `services/task-svc/migrations/003_rls.sql`, `services/messaging-svc/migrations/0007_rls.sql` |
| Least-privilege DB roles | One login role per database, `CONNECT` revoked from `PUBLIC`, superuser for init only | `infra/postgres/init/02-create-roles.sh`; [`OPERATIONS.md`](./OPERATIONS.md) §3 |
| IDOR / cross-org regression test | Two real orgs; user-lookup, directory, tasks, inbox asserted isolated — one entry in a broader CI coverage table, not the sole authz proof | `scripts/security-authz.ts`; CI test jobs; full property → test mapping in `docs/AUTH_AUTHZ_REMEDIATION_PLAN.md`'s Phase 0 |
| Multi-factor authentication | TOTP + WebAuthn, opt-in per member; org-admin-mandatory policy with a grace-period rollout before login blocks an unenrolled admin | `services/auth-svc/app/routes/mfa_totp.py`, `mfa_webauthn.py`, `mfa_challenge.py`; `mfa_service.mfa_gate` |

## 2. Encryption — at rest & in transit (SOC 2 CC6.7 / ISO A.8.24, A.5.33)

| Control | Implementation | Evidence |
|---|---|---|
| Column encryption at rest | AES-256-GCM, random 96-bit nonce, **AAD = `org_id`**, self-describing blob with embedded `key_version` | `services/shared/crypto/crypto.py` (shared by auth-svc, task-svc, integrations-svc, telemetry-svc), messaging-svc crypto (Go, independent implementation of the same format) |
| Envelope keys, per-org DEK | 32-byte DEK per org, wrapped by a KEK, stored in `org_keys` | `services/shared/crypto/crypto.py::Cryptor`; each service keeps its OWN `org_keys` table in `*/migrations/*column_encryption*.sql` |
| KEK provider (prod vs dev) | `KMSKEKProvider` (KMS/Vault interface) vs `DevKEKProvider` (Argon2id-derived) | `services/shared/crypto/crypto.py`; `DATA_KEK_PROVIDER` in `.env.prod.example` |
| Lazy key rotation | `key_version` embedded per ciphertext; old rows decrypt with their generation | `services/shared/crypto/crypto.py::decrypt` / `_dek_for_version` |
| Blind index for encrypted lookup | `HMAC-SHA256(static_key, normalized(value))` for login-by-email | `services/shared/crypto/crypto.py::Cryptor.blind_index`; [`SECURITY.md`](./SECURITY.md) §2 |
| TLS in transit | Caddy terminates TLS (ACME); Postgres `sslmode=require`, Redis auth in prod | `infra/caddy/Caddyfile`; [`OPERATIONS.md`](./OPERATIONS.md) §2–§3 |
| OWASP transport headers | HSTS, `X-Frame-Options: DENY`, nosniff, CSP, Referrer/Permissions-Policy on every response | `services/auth-svc/app/middleware.py::SECURITY_HEADERS` (mirrored in Go) |

> Note: `KMSKEKProvider` is an interface/stub — a real KMS backend must be wired
> before enabling `DATA_KEK_PROVIDER=kms` in production (tracked in
> [`THREAT_MODEL.md`](./THREAT_MODEL.md) §8).

## 3. Audit logging & monitoring (SOC 2 CC7.2–CC7.3 / ISO A.8.15, A.8.16)

| Control | Implementation | Evidence |
|---|---|---|
| Tamper-evident audit log | SHA-256 **hash chain** `entry_hash = SHA256(prev_hash \|\| canonical(...))`; per-org advisory lock prevents chain forks | `services/auth-svc/app/service.py::write_audit` |
| Audit chain verification | Re-walks the chain, returns `{ok, broken_at, reason}` | `services/auth-svc/app/service.py::verify_audit_chain`; endpoint `services/auth-svc/app/routes/internal.py` (`/internal/audit/verify/{org_id}`) |
| Request traceability | `X-Request-Id` on every response, bound into structured logs | `services/auth-svc/app/middleware.py::RequestIDMiddleware` |
| Telemetry | OTEL traces + Prometheus `/metrics` (RED) | `services/auth-svc/app/main.py`; `infra/observability/*` |
| Member-admin actions audited | role change / suspend / reactivate / remove, plus a member's self-service `member.left`, written to the hash chain | `services/auth-svc/app/routes/members_service.py` (`member.*` actions) |
| Authentication events audited | login, failed login, logout, org switch | `services/auth-svc/app/routes/session_events.py` |
| Audit trail readable by the tenant | `GET /auth/audit` (org_admin), keyset-paginated | `services/auth-svc/app/routes/members.py::list_audit`; Members → Security tab |

## 4. Change management (SOC 2 CC8.1 / ISO A.8.32, A.8.25)

| Control | Implementation | Evidence |
|---|---|---|
| CI gate: lint | ruff (Py), golangci-lint (Go), eslint + tsc (JS/TS) | `.github/workflows/ci.yml` (Lint jobs) |
| CI gate: tests | pytest, `go test -race`, vitest across workspaces | `.github/workflows/ci.yml` (Test jobs) |
| CI gate: build | web + desktop build | `.github/workflows/ci.yml` (Build job) |
| Image build provenance | container images built in CI | `.github/workflows/build-images.yml` |
| Idempotent, reviewable migrations | RLS/migrations guarded by existence checks, safe to re-run | `services/*/migrations/*.sql` |

## 5. Vulnerability & supply-chain management (SOC 2 CC7.1 / ISO A.8.8, A.8.28)

| Control | Implementation | Evidence |
|---|---|---|
| SAST (semantic) | CodeQL | `.github/workflows/codeql.yml` |
| SAST (rules) | Semgrep (`p/ci`, `p/secrets`), SARIF uploaded | `.github/workflows/security-extra.yml` (semgrep job) |
| Secret scanning | gitleaks on every push | `.github/workflows/security-extra.yml` (gitleaks job) |
| Dependency / image scanning | Trivy (fs), grype, govulncheck (Go), pip-audit (Py), npm-audit | `.github/workflows/ci.yml` (Security jobs) |
| SBOM | syft SPDX SBOM artifact | `.github/workflows/security-extra.yml` (sbom job) |

## 6. Incident response (SOC 2 CC7.4–CC7.5 / ISO A.5.24–A.5.26)

| Control | Implementation | Evidence |
|---|---|---|
| Breach response runbook | isolate, rotate secrets, revoke sessions, scope via audit log | [`SECURITY.md`](./SECURITY.md) §6 |
| Signing-key compromise | overlapping JWKS publication + `JWT_KID` bump + retire | [`OPERATIONS.md`](./OPERATIONS.md) §4; [`SECURITY.md`](./SECURITY.md) §6 |
| KEK compromise | rotate KEK, re-wrap `org_keys` DEKs (data unchanged) | [`SECURITY.md`](./SECURITY.md) §6 |
| Session revocation | refresh-family revoke; reuse-detection auto-revokes | `services/auth-svc/app/service.py::rotate_refresh_token` / `revoke_family_by_token` |
| Brute-force / credential stuffing | per-IP sensitive-path rate limits + failed-login signal | `services/auth-svc/app/rate_limit.py`; [`SECURITY.md`](./SECURITY.md) §6 |

## 7. Secrets management (SOC 2 CC6.1 / ISO A.8.24, A.5.17)

| Control | Implementation | Evidence |
|---|---|---|
| No secrets in VCS | `keys/*.pem`, `.env*` gitignored; gitleaks enforces | `.gitignore`; `.github/workflows/security-extra.yml` |
| Runtime secret injection | Vault / cloud secret manager / External Secrets Operator | [`OPERATIONS.md`](./OPERATIONS.md) §1 |
| Internal service auth | One secret **per exposing service** (`AUTH_INTERNAL_TOKEN`, `TASK_INTERNAL_TOKEN`, `MESSAGING_INTERNAL_TOKEN`, `WS_GATEWAY_INTERNAL_TOKEN`, `INTEGRATIONS_INTERNAL_TOKEN`) via `X-Internal-Token`, replacing the single shared `TB_INTERNAL_TOKEN`; every checker **fails closed** + constant-time compare in both languages | `services/shared/internal_auth` (Python), `services/shared/internalauth` (Go); `services/auth-svc/app/routes/internal.py` |
| Raw secrets never reach Kafka | Password-reset/email-verify/invite links are redacted from the published event (`outboxId` substituted); `email-worker` pulls the real link via a token-gated, allow-listed internal endpoint instead | `services/auth-svc/app/events/poller.py`; `GET /internal/outbox-events/{outbox_id}` (`internal.py`) |
| Key provisioning per env | fresh Ed25519 keypair per environment; never ship dev keys | [`OPERATIONS.md`](./OPERATIONS.md) §4 |

> Resolved: the **Go** services' `X-Internal-Token` check now fails closed and
> is constant-time, matching the Python `auth-svc` reference — see
> [`THREAT_MODEL.md`](./THREAT_MODEL.md) §4. The remaining residual is that
> every one of these per-service secrets is still a static, long-lived shared
> secret rather than short-lived/mTLS workload identity — see
> [`THREAT_MODEL.md`](./THREAT_MODEL.md) §8.

## 8. Data retention, DSAR & privacy (GDPR/CCPA; SOC 2 P-series / ISO A.5.34, A.8.10–A.8.11)

| Control | Implementation | Evidence |
|---|---|---|
| Data classification | Secret / PII / User content / Metadata tiers + protection per tier | [`SECURITY.md`](./SECURITY.md) §2 |
| Subject access / export | records retrievable by `user_id`/`org_id`; server decrypts on read | [`SECURITY.md`](./SECURITY.md) §4; `crypto.py::decrypt` |
| Right-to-erasure (crypto-shred) | delete the org's `org_keys` row → all `*_enc` columns unreadable in O(1) | [`SECURITY.md`](./SECURITY.md) §4; `org_keys` + `crypto.py` (no DEK ⇒ `CryptoError`) |
| Org erasure is self-service, delayed and reversible | admin-initiated with typed slug confirmation, a configurable grace period and a cancel path; the purge is a scheduled job ordered after the nightly backup, never an HTTP request | `services/auth-svc/app/routes/org_lifecycle.py`, `app/jobs/purge_orgs.py`, `infra/systemd/blisswork-org-purge.timer` |
| Org erasure reaches every store | crypto-shred first (immediate, consumer-independent), then `org.deleted` fans out to task/messaging/notification/telemetry/integrations; messaging also removes attachment BYTES, which are not application-encrypted | `internal/kafka/consumer.go::purgeOrg`, `internal/blob/blob.go::RemoveOrg`, each service's `org_purge` module |
| Erasure survives its own audit trail | `audit_log` is inside the org's RLS scope and is destroyed with it, so a tombstone outside that boundary records the deletion | `deleted_orgs` table (`migrations/0009_org_deletion.sql`, never purged) + the `org.*` Kafka events |
| Per-user erasure | null/overwrite that user's `*_enc` columns | [`SECURITY.md`](./SECURITY.md) §4 |
| Retention | policy-driven; expired data crypto-shredded rather than bulk-deleted | [`SECURITY.md`](./SECURITY.md) §4 |
| Behavioural telemetry: purpose + retention | 90-day raw activity, daily rollups retained; day-partitioned so expiry is a `DROP TABLE` | [`TELEMETRY.md`](./TELEMETRY.md) §1, §3; `services/telemetry-svc/migrations/0001_init.sql` |
| Behavioural telemetry: data minimisation in use | per-event detail (timeline, sessions) is browsable for 7 days only, clamped server-side; longer windows serve aggregates, not a play-by-play | [`TELEMETRY.md`](./TELEMETRY.md) §3; `services/telemetry-svc/app/routes/timeline.py::_visible_floor` |
| Behavioural telemetry: access control | a member reads only their own record; anyone else's requires org_admin | `services/telemetry-svc/app/routes/subject.py::resolve_subject` (+ its dedicated test suite) |
| Behavioural telemetry: transparency | in-product notice + self-service view of one's own record | `packages/app/src/features/ActivityNotice.tsx`, `packages/app/src/routes/MyActivity.tsx` |
| Behavioural telemetry: data minimisation | no window titles, no full-URL aggregates, message previews truncated + encrypted, no names/emails stored | [`TELEMETRY.md`](./TELEMETRY.md) §1; `services/telemetry-svc/app/event_map.py::preview_of` |
| Retention enforcement is fail-loud | the prune refuses to drop a day that was never rolled up and exits non-zero | `services/telemetry-svc/app/jobs/prune.py::assert_rolled_up` |

## 9. Network & boundary protection (SOC 2 CC6.6 / ISO A.8.20–A.8.23)

| Control | Implementation | Evidence |
|---|---|---|
| Single TLS edge | Caddy is the only host-exposed service (80/443) | `infra/caddy/Caddyfile`; [`OPERATIONS.md`](./OPERATIONS.md) §2 |
| CORS allow-list | `WEB_ORIGIN` + scoped localhost/`app://`/`file://` regex, credentialed | `services/auth-svc/app/main.py` |
| Internal endpoints off the public surface | `/internal/*` not under public CORS/JWT | `services/auth-svc/app/routes/internal.py`; messaging-svc `api.go` |
| Network segmentation (prod) | k8s NetworkPolicy / isolated network | [`SECURITY.md`](./SECURITY.md) §1; [`THREAT_MODEL.md`](./THREAT_MODEL.md) §3 |

## 10. Endpoint / desktop client hardening (ISO A.8.1)

| Control | Implementation | Evidence |
|---|---|---|
| Electron context isolation | `contextIsolation: true`, `nodeIntegration: false` on all windows | `apps/desktop/src/main/windows.ts`, `chat-sticky-manager.ts` |
| Minimal IPC surface | fixed typed bridge via `contextBridge.exposeInMainWorld` | `apps/desktop/src/preload/index.ts` |
| Navigation containment | `setWindowOpenHandler` denies in-app windows, opens externally | `apps/desktop/src/main/windows.ts` |
| File-transfer integrity | sha256-verified streamed receive | `apps/desktop/src/main/file-sink.ts` (`filesink:finish`) |

---

## 11. Audit prep checklist

1. **Cross-org isolation:** run `npx tsx scripts/security-authz.ts` against a
   seeded multi-org stack — all checks PASS.
2. **Audit integrity:** `GET /internal/audit/verify/{org_id}` (with
   `X-Internal-Token`) returns `{ok: true}`.
3. **CI evidence:** point the auditor at the latest green run of `ci.yml`,
   `codeql.yml`, and `security-extra.yml`, plus the syft SBOM artifact.
4. **Secrets:** confirm `keys/` and `.env*` are gitignored and the latest
   gitleaks job is clean.
5. **Crypto config:** confirm prod sets `DATA_KEK_PROVIDER=kms` with a wired
   backend and `COOKIE_SECURE=true` (`.env.prod.example`,
   [`OPERATIONS.md`](./OPERATIONS.md) §1).
6. **Open items:** review the residual-risk list in
   [`THREAT_MODEL.md`](./THREAT_MODEL.md) §8 for remediation status.
