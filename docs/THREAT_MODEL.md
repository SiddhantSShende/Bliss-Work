# Threat Model (STRIDE, per trust boundary)

This document complements [`SECURITY.md`](./SECURITY.md) (which describes the
controls) and [`OPERATIONS.md`](./OPERATIONS.md) (rotation / secret-injection
runbooks). Here we walk the system's **trust boundaries** and, for each, apply
STRIDE — **S**poofing, **T**ampering, **R**epudiation, **I**nformation
disclosure, **D**enial of service, **E**levation of privilege — listing the
**existing mitigation** (with a real file/control reference) and the **residual
risk / follow-up**. Mappings to SOC 2 / ISO 27001 controls are in
[`COMPLIANCE.md`](./COMPLIANCE.md).

## 1. Architecture & trust boundaries

Services (ports per the [`OPERATIONS.md`](./OPERATIONS.md) service list):

- `auth-svc` (8001, FastAPI/Python) — identity keystone: signup/login, Ed25519
  JWT signing + JWKS, refresh rotation, invites, the tamper-evident audit log,
  per-org DEK store (`org_keys`).
- `task-svc` (8002, FastAPI/Python) — tasks, assignments, Kafka consumer.
- `notification-svc` (8003, Go) — notification fan-out.
- `messaging-svc` (8004, Go) — DMs, channels, inbox.
- `ws-gateway` (8080, Go) — WebSocket fan-out + WebRTC signaling relay.
- `email-worker` (Kafka consumer, no HTTP) — offline email relay.
- Edge: **Caddy** (`infra/caddy/Caddyfile`) terminates TLS, the only
  host-exposed service.
- Data plane: **Postgres** (DB-per-service), **Kafka**, **Redis**.
- Clients: the **web app** (`apps/web`) and the **desktop/Electron app**
  (`apps/desktop`).

The trust boundaries analyzed below:

| # | Boundary | Crossing |
|---|---|---|
| B1 | Browser / desktop renderer ↔ Edge (Caddy → public HTTP/WS API) | untrusted client → app |
| B2 | Edge ↔ Services (Caddy → service, JWT-authenticated) | edge → service |
| B3 | Service ↔ Service (internal calls via `X-Internal-Token`) | service → service |
| B4 | Services ↔ Datastores (Postgres / Kafka / Redis) | service → data |
| B5 | Desktop Electron IPC (renderer ↔ preload ↔ main / utilityProcess) | in-app privilege split |

---

## 2. B1 — Browser/desktop renderer ↔ Edge (public API)

The widest boundary: anything reachable from a logged-out (or hostile) client
hitting Caddy on 443.

**Spoofing**

- *Mitigation:* identity is proven only by a verified Bearer JWT
  (`auth-svc/app/security/auth_dep.py::get_principal`) — EdDSA over the JWKS, `iss`
  pinned, `exp`/`iat`/`sub` required. Passwords are Argon2id with a constant-time
  dummy verify so login does not leak account existence
  (`auth-svc/app/security/passwords.py::dummy_verify`). Refresh tokens are
  opaque, stored only as `sha256` hashes, rotate on every use, and **reuse of a
  rotated token revokes the whole family**
  (`auth-svc/app/service.py::rotate_refresh_token`).
- *Residual:* no MFA / WebAuthn yet; phishing of a live password + cookie is not
  defended beyond rate limits. Follow-up: optional TOTP/WebAuthn, device binding
  on the refresh family.

**Tampering**

- *Mitigation:* TLS at the edge (Caddy ACME, `infra/caddy/Caddyfile`); the access
  token is signed so a client cannot edit its `org_id`/`roles` claims — identity
  comes from **verified claims only, never from `x-org-id`/`x-user-id` headers**
  (explicit in `auth_dep.py`). Request-body size caps + strict input validation
  (Pydantic / Go validation) reject malformed payloads.
- *Residual:* CSP on API responses is locked to `default-src 'none'`
  (`auth-svc/app/middleware.py`), but the **web app's own** page CSP is delivered
  by the SPA host, not these services — keep it tight there too.

**Repudiation**

- *Mitigation:* every response carries `X-Request-Id`
  (`RequestIDMiddleware`) bound into structured logs; security-relevant identity
  actions are written to the **hash-chained `audit_log`**
  (`auth-svc/app/service.py::write_audit`), verifiable via
  `/internal/audit/verify/{org_id}`.
- *Residual:* audit coverage is centered on auth/identity events; task/message
  mutations are logged operationally but not all into the tamper-evident chain.
  Follow-up: extend the audit chain to high-value task/message admin actions.

**Information disclosure**

- *Mitigation:* CORS is allow-listed to `WEB_ORIGIN` plus a localhost/`app://`/
  `file://` regex for the desktop, with `allow_credentials=True` only because the
  refresh cookie is needed (`auth-svc/app/main.py`). The refresh cookie is
  `HttpOnly`; `COOKIE_SECURE=true` is required in prod (auth-svc warns if false —
  [`OPERATIONS.md`](./OPERATIONS.md) §1). OWASP headers (HSTS, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`) are hard-set on every response
  (`middleware.py::SECURITY_HEADERS`, mirrored in the Go services). Login does not
  leak user existence (constant-time dummy verify).
- *Residual:* the `allow_origin_regex` permits any `localhost:<port>` and any
  `file://` origin to send credentialed requests — acceptable for the desktop but
  **must not** be used as the prod web origin policy on its own. Follow-up: ensure
  prod sets a single exact `WEB_ORIGIN` and relies on the regex only for the
  packaged desktop app.

**Denial of service**

- *Mitigation:* per-IP rate limits via slowapi, with **tighter limits on the
  sensitive `/auth/login` / `/auth/orgs` / `/auth/refresh` paths**
  (`auth-svc/app/rate_limit.py`, `SensitiveRateLimitMiddleware` in `main.py`); the
  JWKS fetch path is guarded by retry + **circuit breaker** so a slow auth-svc
  fails fast instead of pinning every verifier
  (`auth_dep.py`, `_jwks_breaker`).
- *Residual:* rate-limit state is per-process unless backed by shared Redis;
  app-level limits do not replace an edge WAF. Follow-up: terminate volumetric
  abuse at Caddy/WAF and back slowapi with Redis for multi-replica correctness.

**Elevation of privilege**

- *Mitigation:* roles come from the signed token; admin-only routes go through
  `require_org_admin` (`auth_dep.py`). Cross-org access (IDOR) is denied at the
  app layer **and** by Postgres RLS (see B4), proven by the
  `scripts/security-authz.ts` suite (per-user lookup, directory, tasks, inbox all
  asserted isolated across two real orgs).
- *Residual:* the role model is coarse (`org_admin` vs member). Follow-up:
  finer-grained RBAC / per-resource permissions if the product grows.

---

## 3. B2 — Edge ↔ Services (authenticated request path)

Caddy proxies by service name on the internal network; each service
independently verifies the JWT (no implicit trust of "it came from Caddy").

**Spoofing / Elevation**

- *Mitigation:* every service re-verifies the Bearer token against the JWKS
  (`auth_dep.py` in Python; the equivalent JWKS verifier in the Go services) — a
  service never trusts an upstream-asserted identity. JWKS is cached 5 min and
  **force-refreshed on an unknown `kid`**, enabling overlap-free key rotation
  ([`OPERATIONS.md`](./OPERATIONS.md) §4).
- *Residual:* the internal service network is flat in dev compose; in prod, rely
  on k8s NetworkPolicy / segmentation so services aren't directly reachable
  except via the edge.

**Tampering / Information disclosure (in transit)**

- *Mitigation:* TLS terminates at Caddy; for service-to-Postgres and
  service-to-service in prod, `sslmode=require` and an isolated network
  ([`OPERATIONS.md`](./OPERATIONS.md) §3). Canonical error envelopes avoid leaking
  stack traces.
- *Residual:* edge→service hops inside the cluster are plaintext unless an
  mTLS mesh is added. Follow-up: service mesh / mTLS for east-west traffic in
  regulated deployments.

**Denial of service**

- *Mitigation:* per-service rate limits + bounded timeouts; readiness/liveness
  probes (`/healthz`, `/readyz`) let the orchestrator shed unhealthy pods.
- *Residual:* no global concurrency budget across services; a hot path
  (`notification.events.v1`) is scaled by partition count, not by backpressure
  ([`OPERATIONS.md`](./OPERATIONS.md) §5).

**Repudiation** — same audit/request-id story as B1.

---

## 4. B3 — Service ↔ Service (internal `X-Internal-Token`)

Trusted, JWT-free endpoints for service-to-service calls: `auth-svc`
`/internal/users/{id}` and `/internal/audit/verify/{org_id}`
(`auth-svc/app/routes/internal.py`), messaging-svc internal delivery
(`services/messaging-svc/internal/api/internal_delivery.go`), and ws-gateway's
delivery client (`services/ws-gateway/internal/delivery/delivery.go`), consumed by
`email-worker` and the gateways.

**Spoofing**

- *Mitigation:* a shared secret `TB_INTERNAL_TOKEN` carried in the
  `X-Internal-Token` header. In `auth-svc` the check **fails closed** — if the
  token env is unset, *every* call is rejected — and uses
  `secrets.compare_digest` (constant-time) to avoid timing leaks
  (`internal.py`).
- *Resolved:* the **Go** internal-token check (`messaging-svc`
  `internal/api/internal_delivery.go` → `internalAuthOK`) matches the Python
  behavior — it **fails closed** when `TB_INTERNAL_TOKEN` is unset and uses
  `subtle.ConstantTimeCompare`. ws-gateway only *sends* the header
  (`internal/delivery/delivery.go`) and exposes no internal endpoint of its own
  to guard.
- *Residual (real):* both Go and Python still rely on a single static shared
  secret. Move toward short-lived / mTLS service identity so a leaked token can't
  be replayed and rotation becomes automatic.

**Tampering / Information disclosure**

- *Mitigation:* these endpoints are **not mounted under the public CORS/JWT
  surface** (documented in `internal.py` and `messaging-svc` `api.go`); the
  cross-org `/internal/users/{id}` lookup runs under an explicit
  `set_bypass_rls` and returns only a narrow `UserDTO`.
- *Residual:* `bypass_rls` is the one code path that disables the DB backstop —
  it must remain confined to these audited, secret-gated handlers. Follow-up: a
  lint/test that flags any new `set_bypass_rls` / `withBypass` call site.

**Elevation of privilege**

- *Mitigation:* the internal surface is intentionally tiny (user lookup, audit
  verify, message delivery) and read-mostly; possession of the token does not
  grant a general cross-org API.
- *Residual:* the token is a single high-value credential — its compromise grants
  the internal surface org-wide. Rotation is covered in the IR runbook
  ([`SECURITY.md`](./SECURITY.md) §6).

---

## 5. B4 — Services ↔ Datastores (Postgres / Kafka / Redis)

**Spoofing / Elevation**

- *Mitigation:* **per-service least-privilege DB roles** — each service connects
  as its own login that can reach only its own database, `CONNECT` revoked from
  `PUBLIC` (`infra/postgres/init/02-create-roles.sh`,
  [`OPERATIONS.md`](./OPERATIONS.md) §3); the superuser is init/migration-only.
- *Residual:* a compromised service still has full DML on its own DB; RLS limits
  *cross-org* reach, not intra-service blast radius.

**Tampering**

- *Mitigation:* the **tamper-evident audit log** is a SHA-256 hash chain
  (`entry_hash = SHA256(prev_hash || canonical(...))`,
  `auth-svc/app/service.py`), serialized per org via a transaction-scoped advisory
  lock so concurrent writers can't fork the chain; any edit/delete/reorder is
  caught by `verify_audit_chain` (exposed at `/internal/audit/verify/{org_id}`).
- *Residual:* the chain is verifiable but stored in the same DB an attacker with
  write access could truncate; detection (not prevention) of tail-truncation.
  Follow-up: periodically anchor the latest `entry_hash` externally (WORM bucket /
  notarization) so truncation is also detectable.

**Information disclosure**

- *Mitigation:* PII and user content are **AES-256-GCM encrypted at rest with a
  per-org DEK** (`*_enc` columns), AAD bound to `org_id` so a ciphertext can't be
  replayed into another org (`*/app/crypto.py`); DEKs are wrapped by a KEK
  (KMS/Vault in prod, Argon2id-derived in dev). Email has an HMAC **blind index**
  for login lookup without decrypting. TLS / `sslmode=require` and Redis auth in
  prod ([`OPERATIONS.md`](./OPERATIONS.md) §1, §3).
- *Residual:* metadata (org/user ids, timestamps, status) is intentionally
  unencrypted for queryability; the server is the crypto boundary (not E2E) so a
  compromised app process can decrypt. Crypto-shredding (deleting the `org_keys`
  row) is the erasure lever ([`SECURITY.md`](./SECURITY.md) §4). The `KMSKEKProvider`
  is a **stub** — a real backend must be wired before `DATA_KEK_PROVIDER=kms` in
  prod (`crypto.py`, noted in code).

**Repudiation**

- *Mitigation:* RLS is **ENABLE + FORCE** on every org-bearing table so even the
  schema-owning role is policed; the policy keys off the transaction-local
  `app.org_id` GUC and **fails closed** (`NULLIF(...,'')::uuid` → unset GUC sees
  zero rows) — see `*/migrations/*rls.sql`. `app.bypass_rls` is the only escape
  and is set only by trusted server code.
- *Residual:* RLS correctness depends on every query running inside the
  org-scoped transaction (`withOrg` in Go, `set_org_guc` in Python); a future
  query that forgets the wrapper fails closed (good) but breaks features (caught
  by the IDOR suite + tests).

**Denial of service**

- *Mitigation:* connection pooling, bounded queries (keyset pagination in the
  inbox), Kafka partitioning for fan-out parallelism.
- *Residual:* single-broker Kafka in compose is not HA — prod must run a
  multi-broker cluster with `REPLICATION_FACTOR=3`
  ([`OPERATIONS.md`](./OPERATIONS.md) §5).

---

## 6. B5 — Desktop Electron IPC (renderer ↔ preload ↔ main)

The desktop app (`apps/desktop`) splits privilege between an untrusted **renderer**
(web content) and the trusted **main** / utilityProcess (Node, filesystem, WS).

**Spoofing / Elevation of privilege**

- *Mitigation:* every `BrowserWindow` is created with
  `contextIsolation: true`, `nodeIntegration: false`
  (`apps/desktop/src/main/windows.ts`, `chat-sticky-manager.ts`). The renderer
  gets **only** a fixed, typed surface via `contextBridge.exposeInMainWorld`
  (`apps/desktop/src/preload/index.ts`) — `setToken`, `pinTask`, `listPinned`, WS
  event subscription, RTC signaling, file-sink, incremental hash — never raw
  `ipcRenderer` or Node APIs.
- *Residual:* `sandbox: false` (the preload uses `ipcRenderer`), so a renderer RCE
  has a slightly larger preload surface than a fully sandboxed one. Follow-up:
  move to `sandbox: true` with a sandbox-compatible preload where feasible.

**Tampering**

- *Mitigation:* `webContents.setWindowOpenHandler` denies in-app window creation
  and routes external URLs to the OS browser
  (`windows.ts`), preventing arbitrary navigation in a privileged window. The
  WebRTC file receiver streams chunks to a main-process disk sink and verifies a
  **sha256** of the completed file (`filesink:finish` →
  `apps/desktop/src/main/file-sink.ts`), so a tampered/corrupt transfer is
  rejected.
- *Residual:* IPC channel arguments from the renderer (e.g. `task:pin`,
  `filesink:*` paths/ids) are trusted inputs to main; main must continue to
  validate them (path confinement to Downloads, id format) rather than assume a
  well-behaved renderer.

**Information disclosure**

- *Mitigation:* the access token lives in the renderer and is **pushed** to the
  utilityProcess via IPC (`auth:token`) only for WS/REST use; the long-lived
  refresh **cookie** stays in the renderer/session, and the host asks the renderer
  for a fresh token via `token:request` rather than persisting credentials in
  main.
- *Residual:* a malicious local process / renderer compromise can read the
  in-memory access token (short-lived by design). Deep-link invite tokens arrive
  via `taskboard://` (`deeplink:invite`) and should be treated as
  attacker-influenced input.

**Denial of service / Repudiation** — local-only surface; covered by the same
server-side rate limits and audit log once IPC actions hit the API.

---

## 7. Cross-cutting controls & verification

- **Supply chain (Tampering/Disclosure of the build):** CI runs CodeQL
  (`.github/workflows/codeql.yml`), Semgrep + gitleaks + SBOM/syft
  (`.github/workflows/security-extra.yml`), and Trivy/grype/govulncheck/pip-audit
  (`.github/workflows/ci.yml`). See [`COMPLIANCE.md`](./COMPLIANCE.md) for the
  evidence matrix.
- **Cross-org isolation proof:** `scripts/security-authz.ts` is the executable
  regression test for the IDOR/RLS claims above.
- **Secrets:** `keys/*.pem`, `.env*` are gitignored; gitleaks scans every push;
  rotation runbooks in [`OPERATIONS.md`](./OPERATIONS.md) and
  [`SECURITY.md`](./SECURITY.md) §6.

## 8. Top residual risks (prioritized follow-ups)

1. **Go internal-token check fails open + non-constant-time** — align with
   `auth-svc`'s fail-closed `secrets.compare_digest` pattern (B3).
2. **`KMSKEKProvider` is a stub** — wire a real KMS/Vault backend before
   `DATA_KEK_PROVIDER=kms` in prod (B4).
3. **Audit chain truncation is detectable but not prevented** — externally anchor
   the latest `entry_hash` (B4).
4. **No MFA** — add TOTP/WebAuthn for phishing-resistant auth (B1).
5. **East-west traffic is unauthenticated/plaintext inside the cluster** — add
   NetworkPolicy + mTLS (B2/B3).
6. **`sandbox: false`** in Electron windows — move toward a sandboxed preload (B5).
