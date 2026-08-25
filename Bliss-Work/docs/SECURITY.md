# Security & Data Protection

Authoritative reference for BlissWork/Task-Board's security controls, data
handling, and compliance posture. Operational runbooks (secret injection, JWKS
rotation, prod env) live in [`OPERATIONS.md`](./OPERATIONS.md); this document
covers the security architecture, data protection, and compliance mapping.

## 1. Security architecture (defense in depth)

| Layer | Control | Where |
|---|---|---|
| Identity | Argon2id password hashing (constant-time dummy verify), Ed25519/JWKS access tokens, rotating refresh tokens with family reuse-detection, optional TOTP/WebAuthn as a second factor (org-admin-mandatory available, with a grace-period rollout) | `auth-svc` |
| Authorization | Org-scoped claims from verified JWT only (never trusts headers); per-endpoint authz; **Postgres Row-Level Security per org** as a DB-enforced second gate | all services |
| **Data at rest** | **AES-256-GCM column encryption, per-org DEK** (envelope) for PII + message bodies + task content; per-org keys enable crypto-shredding | auth/messaging/task |
| Data in transit | TLS at the edge (Caddy / cert-manager), Postgres `sslmode`, Redis auth, internal network isolation (k8s NetworkPolicy) | infra |
| Application | per-endpoint rate limits, OWASP security headers (HSTS/CSP/X-Frame-Options), strict input validation, request-body size caps, panic recovery, canonical error envelopes | all services |
| Supply chain | CI SAST (CodeQL, Semgrep), secret scanning (gitleaks), dependency + container scanning (Trivy/grype, govulncheck, pip-audit, npm-audit), SBOM (syft) | `.github/workflows` |
| Observability | structured request-id logs, OTEL traces, Prometheus metrics, tamper-evident audit log | all services |

**Session model.** Access tokens are short-lived (`JWT_ACCESS_TTL_SECONDS`,
default 300s / 5 minutes) and `verify_bearer` is purely stateless — there is
no cross-service revocation store. **Logout revokes the refresh-token
family. Access tokens may remain valid until they expire, even after
logout** — never state that logout revokes the access JWT, because it
doesn't; the short TTL is what bounds that residual window instead of a
Redis denylist every JWT-verifying service would otherwise need. MFA
(TOTP/WebAuthn) is opt-in per member, and an org can additionally require it
for `org_admin` roles: turning that policy on starts a grace period
(`orgs.mfa_grace_period_ends_at`, `MFA_GRACE_PERIOD_DAYS`, default 14 days)
during which a non-enrolled admin sees a warning banner but can still sign
in; only once the deadline passes does login block at the password step and
route the admin into enrollment.

## 2. Data classification

| Class | Examples | Protection |
|---|---|---|
| **Secret** | Ed25519 signing key, KEK / `DATA_MASTER_PASSPHRASE`, `DATA_BLIND_INDEX_KEY`, per-service internal tokens (`AUTH_INTERNAL_TOKEN`, `TASK_INTERNAL_TOKEN`, `MESSAGING_INTERNAL_TOKEN`, `WS_GATEWAY_INTERNAL_TOKEN`, `INTEGRATIONS_INTERNAL_TOKEN`), DB passwords | KMS / secret manager only; never in VCS (`keys/*.pem`, `.env*` gitignored); never logged |
| **PII** | user email, display name | AES-256-GCM at rest (`users.email_enc`/`display_name_enc`); email also has an HMAC **blind index** for login lookup |
| **User content** | DM + channel message bodies, message/inbox previews, task title/description, mail subjects + bodies + every To/Cc/Bcc address | AES-256-GCM at rest (`*_enc` columns) |
| **Metadata** | org/user ids, timestamps, status, roles, read receipts | not encrypted (needed for queries/joins); protected by authz + RLS |

## 3. Encryption at rest (envelope, per-org)

- **Cipher:** AES-256-GCM, random 96-bit nonce per encryption, AAD = `org_id` (a
  ciphertext can't be replayed into another org). Self-describing blob:
  `0x01 || key_version(uint16) || nonce(12) || ciphertext||tag`.
- **Keys:** each org has a 32-byte **Data Encryption Key (DEK)**, generated on
  first use and stored **wrapped** in that service's `org_keys` table. The DEK is
  wrapped by a **Key Encryption Key (KEK)**:
  - *Prod:* a KMS / Vault Transit key (`DATA_KEK_PROVIDER=kms`).
  - *Dev:* a master key derived from a passphrase via **Argon2id**.
- **Rotation:** `key_version` is embedded in every ciphertext, so DEK rotation is
  lazy — old rows decrypt with their generation, new writes use the current one.
- **Transparency:** the server holds the keys and decrypts in-process, so search,
  previews, notifications, and offline email keep working. This is at-rest
  protection (DB/disk/backup theft), **not** client-side E2E.

## 4. PII / data-subject requests (GDPR/CCPA)

- **Access / export:** a data subject's records are retrievable by `user_id` /
  `org_id`; the server decrypts on read to produce a portable export.
- **Erasure (right to be forgotten) via crypto-shredding:** deleting an org's row
  from `org_keys` renders **all** of that org's encrypted columns permanently
  unreadable in O(1) — no need to scrub every row or wait for backup expiry. For
  per-user erasure, null/overwrite that user's `*_enc` columns.
- **Retention:** message/audit retention is policy-driven; the per-org DEK means
  expired data can be crypto-shredded rather than bulk-deleted.

## 5. Compliance control mapping (SOC 2 / ISO 27001 — illustrative)

| Control area | Implementation |
|---|---|
| Access control (CC6.1) | JWT authz + RLS per org; least-privilege per-service DB roles |
| Encryption (CC6.7) | TLS in transit; AES-256-GCM at rest with KMS-managed keys |
| Change management (CC8.1) | CI (lint/test/SAST/scan) gating; PR review |
| Vulnerability mgmt (CC7.1) | CodeQL/Semgrep/Trivy/grype/govulncheck/pip-audit/npm-audit + SBOM |
| Audit logging (CC7.2) | tamper-evident (hash-chained) `audit_log`; security events to the log pipeline |
| Incident response (CC7.4) | runbooks below; alerting on the security-event stream |
| Secrets management | KMS / Vault / sealed-secrets; rotation procedures in `OPERATIONS.md` |

## 6. Incident response runbooks

- **Suspected data breach:** isolate the affected service/pod; rotate all secrets
  (KEK, the per-service internal tokens, DB passwords); revoke active sessions
  (`refresh_tokens`); review the audit log + security-event stream for scope;
  preserve evidence; notify per the legal/DPA timeline.
- **Signing-key (Ed25519) compromise:** generate a new keypair, publish both kids
  in JWKS, bump `JWT_KID`, wait out access-TTL + verifier cache, retire the old
  key (see `OPERATIONS.md`). All existing access tokens expire within the TTL.
- **KEK / encryption-key compromise:** rotate the KEK in the KMS; re-wrap all
  `org_keys` DEKs under the new KEK (the DEKs and thus the data are unchanged);
  rotate `DATA_BLIND_INDEX_KEY` only with a full email re-index.
- **Credential stuffing / brute force:** per-IP rate limits already throttle
  `/auth/login`; the security-event stream flags failed-login spikes for blocking
  at the WAF/edge.

## 7. Pen-test preparation

Scope: all HTTP/WS endpoints, authz/IDOR (RLS is the backstop), the encryption
boundary, secret handling, and the desktop/Electron IPC surface. Provide a
staging env with seeded multi-org data so cross-org isolation (RLS) can be
exercised. CI SAST/DAST findings should be triaged before an external test.

## 8. Screenshot protection — what it does and does not do

The app tries to stop screenshots of workspace content, and where it cannot, it
detects the attempt, refuses the keystroke, tells the user and records it. Read
this before repeating the claim to a customer, because the honest scope is
narrower than the feature name suggests.

**There is no server-side control, and there cannot be.** A screenshot is taken
by the operating system's compositor from pixels that have already been
decrypted and drawn on the user's own machine. A backend cannot see the
framebuffer, cannot see the keyboard, and cannot un-render pixels. Any claim
that screenshots are "blocked at the backend" is false.

What the DESKTOP app actually does, in
`apps/desktop/src/main/screenshot-guard.ts`:

| Control | Windows | macOS | Linux/X11 |
|---|---|---|---|
| `setContentProtection(true)` — window excluded from capture | Yes (`WDA_EXCLUDEFROMCAPTURE`) | Yes (`NSWindowSharingNone`) | **No — documented no-op** |
| `PrintScreen` intercepted while we hold focus | Yes | n/a | Yes |
| macOS `Cmd+Shift+3/4/5` intercepted | n/a | Detected, **not prevented** (OS-reserved chords) | n/a |
| Warning toast to the user | Yes | Yes | Yes |
| `screenshot.attempted` recorded in the activity record | Yes | Yes | Yes |

Applied through `hardenWindow` so every window creation path — main window,
task sticky notes, pinned chat windows — gets it without anyone remembering to.

The WEB app (`packages/app/src/lib/screenGuard.ts`) can do strictly less, and
does the part it can: a page cannot exclude itself from capture, so there is no
row one above it could fill, but capture chords delivered to the page —
`PrintScreen`, `Print`, and macOS `Cmd+Shift+3/4/5` — are refused with
`preventDefault`, warned about with the same message, and reported. It is
installed only when the Electron host is absent, so the two never both report
the same keystroke.

**Not covered.** Win+Shift+S and the Snipping Tool; `gnome-screenshot`,
Flameshot, Spectacle, ShareX and every other third-party capture tool; screen
recording started before the window opened; a virtual machine or capture card;
and a phone camera pointed at the monitor. The Linux row above matters in
practice: the AppImage and `.deb` are the builds produced natively by this repo.

**Two consequences to plan for.**

1. Content protection blacks the window out in *all* capture, including
   legitimate screen shares. Demoing BlissWork over Zoom, Teams or Meet shows a
   black rectangle, and so does a support call. This is currently always-on.
2. `screenshot.attempted` reaches the record by one of two routes, and never
   both. For a user who consented to the activity agent and paired a device it
   goes through the agent (`main/activity-state.ts`, category `system`).
   For everyone else — including every web user — the client reports it through
   the ordinary session beacon it already sends (category `security`), which is
   session telemetry rather than monitoring. Declining the activity agent
   therefore costs a member their app-usage record, not the security record of a
   refused capture. Both routes are `source`-tagged as self-reported, because
   they are: the client is saying what it saw and refused, which is not the same
   as proving nothing was captured.

   Admins read it under **Security** in a member's activity timeline.

Treat this as **deterrence, detection and an audit trail**, not prevention. For
content that genuinely must not leave a screen, the control has to be "do not
put it on that screen", not "ask the OS nicely".
