# Key & Secret Rotation Runbook

How to rotate every secret/key in the system. See [SECURITY.md](./SECURITY.md)
for the crypto architecture and [OPERATIONS.md](./OPERATIONS.md) for env/secret
injection.

## 1. Data Encryption Key (DEK) — per org, per service

Each org has a DEK per service DB (authdb/taskdb/messagingdb), wrapped in
`org_keys`. Rotation is **lazy**: a new generation (`key_version`) is created and
the old one retired; existing ciphertext keeps decrypting via its embedded
`key_version`, only new writes use the new DEK.

```sh
# Rotate authdb's DEK for an org (internal, shared-secret auth):
curl -s -X POST "http://localhost:8001/internal/keys/rotate/<ORG_ID>" \
     -H "X-Internal-Token: $TB_INTERNAL_TOKEN"
# -> {"orgId":"...","oldVersion":1,"newVersion":2}
```

- Repeat per service DB to fully rotate an org (task-svc / messaging-svc expose
  the same `Cryptor.rotate_dek` / `RotateDEK` capability; add an equivalent
  internal route there if you rotate those DBs routinely).
- **Optional re-encryption:** lazy rotation leaves old rows under the old DEK. To
  force every row onto the new DEK, run a backfill that re-writes each encrypted
  column (decrypt→encrypt) after rotation, then the old `org_keys` row can be
  deleted. Without it, keep the retired row so old rows stay readable.
- **Crypto-shred (GDPR erasure):** `DELETE FROM org_keys WHERE org_id = '<ORG>'`
  in a service DB makes that org's encrypted columns permanently unreadable.

## 2. Key Encryption Key (KEK)

- **Vault Transit (prod):** the KEK lives in Vault and never leaves it. Rotate it
  with `vault write -f transit/keys/taskboard-dek/rotate`. Vault's ciphertext is
  self-versioning (`vault:vN:...`), so previously wrapped DEKs keep unwrapping;
  optionally `transit/rewrap` the stored `wrapped_dek` values onto the new KEK
  version. No app change.
- **Dev (Argon2id passphrase):** changing `DATA_MASTER_PASSPHRASE`/`DATA_MASTER_SALT`
  changes the KEK and makes existing `org_keys` unwrappable — only do this on a
  fresh/wiped DB, or re-wrap every DEK first. Dev only; prod uses KMS.

## 3. Blind-index key (`DATA_BLIND_INDEX_KEY`)

Load-bearing for email login. Rotating it requires recomputing `users.email_bidx`
for every user (decrypt `email_enc` → `HMAC` with the new key). Treat like the
JWT signing key; do not rotate casually.

## 4. JWT signing key (Ed25519) — zero-downtime dual-kid

Already supported via `JWT_KID`/`JWT_PUBLIC_KEY_PATH_PREVIOUS`/`JWT_KID_PREVIOUS`
(see OPERATIONS.md): publish both kids in JWKS, switch signing to the new key,
wait out the access-token TTL + verifier JWKS cache, then retire the old key. All
existing access tokens expire within the TTL.

## 5. `TB_INTERNAL_TOKEN` (service-to-service)

Rotate via the secret manager and roll the services. The internal endpoints fail
closed (reject all) if unset and use constant-time comparison, so a brief mismatch
window only rejects internal calls (retried) — never accepts an attacker.

## 6. Database passwords (`*_DB_PASSWORD`)

`ALTER ROLE <svc>_user WITH PASSWORD '<new>'`, update the secret + the service's
`*_DATABASE_URL`, roll the service.
