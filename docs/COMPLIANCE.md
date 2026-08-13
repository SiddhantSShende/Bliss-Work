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
| IDOR / cross-org regression test | Two real orgs; user-lookup, directory, tasks, inbox asserted isolated | `scripts/security-authz.ts`; CI test jobs |

## 2. Encryption — at rest & in transit (SOC 2 CC6.7 / ISO A.8.24, A.5.33)

| Control | Implementation | Evidence |
|---|---|---|
| Column encryption at rest | AES-256-GCM, random 96-bit nonce, **AAD = `org_id`**, self-describing blob with embedded `key_version` | `services/auth-svc/app/crypto.py`, `services/task-svc/app/crypto.py`, messaging-svc crypto |
| Envelope keys, per-org DEK | 32-byte DEK per org, wrapped by a KEK, stored in `org_keys` | `*/app/crypto.py::Cryptor`; `org_keys` table in `*/migrations/*column_encryption*.sql` |
| KEK provider (prod vs dev) | `KMSKEKProvider` (KMS/Vault interface) vs `DevKEKProvider` (Argon2id-derived) | `services/auth-svc/app/crypto.py`; `DATA_KEK_PROVIDER` in `.env.prod.example` |
| Lazy key rotation | `key_version` embedded per ciphertext; old rows decrypt with their generation | `crypto.py::decrypt` / `_dek_for_version` |
| Blind index for encrypted lookup | `HMAC-SHA256(static_key, normalized(value))` for login-by-email | `crypto.py::blind_index`; [`SECURITY.md`](./SECURITY.md) §2 |
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
| Member-admin actions audited | role change / suspend / reactivate / remove written to the hash chain | `services/auth-svc/app/routes/members_service.py` (`member.*` actions) |
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
| Internal service auth | `TB_INTERNAL_TOKEN` via `X-Internal-Token`; auth-svc **fails closed** + constant-time compare | `services/auth-svc/app/routes/internal.py` (`secrets.compare_digest`) |
| Key provisioning per env | fresh Ed25519 keypair per environment; never ship dev keys | [`OPERATIONS.md`](./OPERATIONS.md) §4 |

> Audit finding to track: the **Go** services' `X-Internal-Token` check is gated
> on a non-empty env (fails *open* if unset) and is not constant-time — see
> [`THREAT_MODEL.md`](./THREAT_MODEL.md) §4 / §8. The Python `auth-svc` path is the
> correct fail-closed reference.

## 8. Data retention, DSAR & privacy (GDPR/CCPA; SOC 2 P-series / ISO A.5.34, A.8.10–A.8.11)

| Control | Implementation | Evidence |
|---|---|---|
| Data classification | Secret / PII / User content / Metadata tiers + protection per tier | [`SECURITY.md`](./SECURITY.md) §2 |
| Subject access / export | records retrievable by `user_id`/`org_id`; server decrypts on read | [`SECURITY.md`](./SECURITY.md) §4; `crypto.py::decrypt` |
| Right-to-erasure (crypto-shred) | delete the org's `org_keys` row → all `*_enc` columns unreadable in O(1) | [`SECURITY.md`](./SECURITY.md) §4; `org_keys` + `crypto.py` (no DEK ⇒ `CryptoError`) |
| Per-user erasure | null/overwrite that user's `*_enc` columns | [`SECURITY.md`](./SECURITY.md) §4 |
| Retention | policy-driven; expired data crypto-shredded rather than bulk-deleted | [`SECURITY.md`](./SECURITY.md) §4 |
| Behavioural telemetry: purpose + retention | 90-day raw activity, daily rollups retained; day-partitioned so expiry is a `DROP TABLE` | [`TELEMETRY.md`](./TELEMETRY.md) §1, §3; `services/telemetry-svc/migrations/0001_init.sql` |
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
