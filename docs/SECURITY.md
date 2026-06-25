# Security & Data Protection

Authoritative reference for BlissWork/Task-Board's security controls, data
handling, and compliance posture. Operational runbooks (secret injection, JWKS
rotation, prod env) live in [`OPERATIONS.md`](./OPERATIONS.md); this document
covers the security architecture, data protection, and compliance mapping.

## 1. Security architecture (defense in depth)

| Layer | Control | Where |
|---|---|---|
| Identity | Argon2id password hashing (constant-time dummy verify), Ed25519/JWKS access tokens, rotating refresh tokens with family reuse-detection | `auth-svc` |
| Authorization | Org-scoped claims from verified JWT only (never trusts headers); per-endpoint authz; **Postgres Row-Level Security per org** as a DB-enforced second gate | all services |
| **Data at rest** | **AES-256-GCM column encryption, per-org DEK** (envelope) for PII + message bodies + task content; per-org keys enable crypto-shredding | auth/messaging/task |
| Data in transit | TLS at the edge (Caddy / cert-manager), Postgres `sslmode`, Redis auth, internal network isolation (k8s NetworkPolicy) | infra |
| Application | per-endpoint rate limits, OWASP security headers (HSTS/CSP/X-Frame-Options), strict input validation, request-body size caps, panic recovery, canonical error envelopes | all services |
| Supply chain | CI SAST (CodeQL, Semgrep), secret scanning (gitleaks), dependency + container scanning (Trivy/grype, govulncheck, pip-audit, npm-audit), SBOM (syft) | `.github/workflows` |
| Observability | structured request-id logs, OTEL traces, Prometheus metrics, tamper-evident audit log | all services |

## 2. Data classification

| Class | Examples | Protection |
|---|---|---|
| **Secret** | Ed25519 signing key, KEK / `DATA_MASTER_PASSPHRASE`, `DATA_BLIND_INDEX_KEY`, `TB_INTERNAL_TOKEN`, DB passwords | KMS / secret manager only; never in VCS (`keys/*.pem`, `.env*` gitignored); never logged |
| **PII** | user email, display name | AES-256-GCM at rest (`users.email_enc`/`display_name_enc`); email also has an HMAC **blind index** for login lookup |
| **User content** | DM + channel message bodies, message/inbox previews, task title/description | AES-256-GCM at rest (`*_enc` columns) |
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
  (KEK, `TB_INTERNAL_TOKEN`, DB passwords); revoke active sessions
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
