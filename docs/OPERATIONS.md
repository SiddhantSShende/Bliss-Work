# Task-Board — Operations Runbook

Production operations for the Task-Board stack. This complements the deployment
manifests:

- **`docker-compose.prod.yml`** — single prod host / small scale.
- **Helm chart** — real horizontal scale, HA, rolling deploys on Kubernetes.

Services: `auth-svc` (8001), `task-svc` (8002), `email-worker` (Kafka consumer,
no HTTP), `notification-svc` (8003), `messaging-svc` (8004), `ws-gateway` (8080).
Each HTTP service exposes `/healthz` (liveness) and `/readyz` (readiness);
`email-worker` has neither (liveness = process up).

---

## 1. Secret injection

**Never commit secrets.** `.env`, `*.local`, and `keys/*.pem` are gitignored.
`docker-compose.prod.yml` reads everything from `.env.prod` (also never
committed). In a real deployment, source secrets from a manager rather than a
file on disk:

| Platform              | Mechanism                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| HashiCorp Vault       | `vault agent` / Vault Secrets Operator renders `.env.prod` or env at boot. |
| AWS / GCP / Azure     | Secrets Manager / Secret Manager / Key Vault → injected at task start.     |
| Kubernetes            | **External Secrets Operator** syncs the manager → a `Secret`; mount as env.|
| Plain Docker host     | Lock down `.env.prod` to `chmod 600`, root-owned; prefer `docker secret`.  |

Rule of thumb: the secret should land in process env / a tmpfs file at runtime,
never in an image layer, git, or a world-readable file.

### Required production env (differs from dev)

| Variable                                   | Dev value            | Production requirement                                            |
| ------------------------------------------ | -------------------- | ---------------------------------------------------------------- |
| `COOKIE_SECURE`                            | `false`              | **`true`** — refresh cookie is TLS-only (auth-svc warns if false).|
| `COOKIE_SAMESITE`                          | `lax`                | `lax` if web + auth share a registrable domain; `none` cross-site.|
| `TB_INTERNAL_TOKEN`                        | `dev-internal-token` | **Real high-entropy secret** (≥32 random bytes). Service-to-service auth.|
| `POSTGRES_PASSWORD`                        | `taskboard_dev_pw`   | Real superuser password (init/admin only).                       |
| `AUTH_DB_PASSWORD` … `EMAIL_DB_PASSWORD`   | —                    | One real password per per-service role (see §3).                 |
| `*_DATABASE_URL`                           | shared `taskboard`   | Per-service least-priv users + `sslmode=require` (see §3).        |
| `REDIS_PASSWORD`                           | (none)               | Real password — Redis is shared on the network.                  |
| `JWT_KID`                                  | `dev-ed25519-1`      | A real, rotated key id (see §4).                                  |
| `WEB_ORIGIN` / `INVITE_BASE_URL`           | `localhost:5173`     | Public HTTPS origin, e.g. `https://app.example.com`.             |
| `DOMAIN` / `ACME_EMAIL`                    | —                    | Public DNS name + contact for Caddy ACME TLS.                    |
| `REPLICATION_FACTOR`                       | `1`                  | `3` on a multi-broker Kafka cluster (see §5).                    |

Generate strong secrets: `openssl rand -base64 48` (or `-hex 32`).

---

## 2. TLS / reverse proxy (edge)

Caddy is the only host-exposed service (80/443). It terminates public TLS and
proxies to internal services by name. **Point a public DNS A/AAAA record for
`${DOMAIN}` at the host** so Caddy's ACME HTTP-01 challenge can issue certs.
Persist the `caddy_data` volume — it holds issued certs and the ACME account.
For a private CA / pre-issued certs, swap the global `email` line for per-site
`tls /etc/caddy/cert.pem /etc/caddy/key.pem`.

The prod `caddy` service runs a **custom WAF-enabled build** by default
(`infra/caddy/Dockerfile`, Caddyfile `infra/caddy/Caddyfile.waf`) — see **§8**
for the OWASP-CRS WAF. To run a plain edge (e.g. a managed WAF in front), swap
to `image: caddy:2.8-alpine` + the stock `infra/caddy/Caddyfile`.

### In-transit TLS everywhere (not just the edge)

Public TLS stops at Caddy; this stack ALSO encrypts the **internal** hops so a
compromised co-tenant or a packet capture on the Docker bridge can't read
credentials or row/message data:

| Hop                         | Mechanism                                  | Section |
| --------------------------- | ------------------------------------------ | ------- |
| Browser/desktop → Caddy     | ACME TLS (Let's Encrypt) + HSTS            | this §  |
| App services → Postgres     | `ssl=on` + client `sslmode=verify-full`    | §3      |
| ws-gateway/worker → Redis   | `requirepass` (+ `rediss://` TLS, caveats) | §7      |
| Producers/consumers → Kafka | PLAINTEXT (dev parity); SASL_SSL for prod  | §6      |

**Dev parity note:** the dev `docker-compose.yml` intentionally stays plaintext
(`sslmode=disable`, no Redis password, Kafka PLAINTEXT). Every hardening below is
**prod-only** and lives in `docker-compose.prod.yml` / `.env.prod` — the running
dev stack is untouched.

---

## 3. Per-service database roles (least privilege)

`infra/postgres/init/02-create-roles.sh` creates one login role per database
(`auth_user`→`authdb`, `task_user`→`taskdb`, `messaging_user`→`messagingdb`,
`notification_user`→`notificationdb`, `email_user`→`emaildb`). Each can connect
to **only its own database**; `CONNECT` is revoked from `PUBLIC`. Passwords come
from `*_DB_PASSWORD` env vars (psql variables) — not hardcoded.

After first init, point each service's `*_DATABASE_URL` at its own user and
**verify-full TLS** (encrypt + validate the server cert + match the hostname):

```
AUTH_DATABASE_URL=postgresql://auth_user:${AUTH_DB_PASSWORD}@postgres:5432/authdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
TASK_DATABASE_URL=postgresql://task_user:${TASK_DB_PASSWORD}@postgres:5432/taskdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
MESSAGING_DATABASE_URL=postgres://messaging_user:${MESSAGING_DB_PASSWORD}@postgres:5432/messagingdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
NOTIFICATION_DATABASE_URL=postgres://notification_user:${NOTIFICATION_DB_PASSWORD}@postgres:5432/notificationdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
EMAIL_DATABASE_URL=postgres://email_user:${EMAIL_DB_PASSWORD}@postgres:5432/emaildb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
```

The superuser (`POSTGRES_USER`) is reserved for init/migrations/admin only —
application traffic must use the per-service users. These roles are created only
on a **fresh** data directory (empty `pgdata`); to apply them to an existing DB,
run the SQL manually as the superuser.

### Postgres in-transit TLS (server side)

The prod `postgres` service runs with `ssl=on` and a server cert/key + CA bundle
mounted at `/etc/postgres/certs` (`docker-compose.prod.yml` `command:` +
`volumes:`), TLSv1.2 floor. The CA is also mounted **read-only into every app
service** at `/etc/ssl/db/ca.crt` — which is the `sslrootcert` path above.

**Driver support (no code change needed):** both DB drivers in this stack parse
the libpq `sslmode` / `sslrootcert` query params straight from the DSN —
`pgx` (messaging-svc, notification-svc) and `asyncpg` via SQLAlchemy (auth-svc,
task-svc, email-worker). `verify-full` additionally checks the cert hostname, so
the server cert's CN/SAN MUST be `postgres` (the helper script sets this).

#### Generating the certs

```bash
# Self-signed CA + Postgres server cert (CN/SAN = postgres). dev/staging:
scripts/gen-db-certs.sh
# verify:
openssl verify -CAfile infra/postgres/certs/ca.crt infra/postgres/certs/server.crt
```

Outputs `infra/postgres/certs/{ca.crt,ca.key,server.crt,server.key}` (gitignored).
Keep `ca.key` offline (or delete it) — it can mint trusted server certs.

**Real production:** do NOT ship a self-signed CA. Use a **managed Postgres**
(RDS / Cloud SQL / Azure DB — download their CA bundle and mount it as
`/etc/ssl/db/ca.crt`; server cert/key are managed for you, so you can drop the
`postgres` service entirely and point the URLs at the managed host), or your
**org PKI / cert-manager / Vault PKI** to issue the server leaf with the org root
as the CA. In all cases only `ca.crt` is mounted into the app services; the
server key never leaves the DB host.

---

## 4. Ed25519 keypair + JWKS key rotation

`auth-svc` signs access tokens with an Ed25519 private key and publishes the
matching public key at `/.well-known/jwks.json`, tagged with `JWT_KID`. Other
services fetch and cache the JWKS (5 min TTL) and verify tokens by the `kid` in
the token header. The verifier already force-refreshes the JWKS on an **unknown
`kid`** (`auth-svc/app/security/auth_dep.py`), which is what makes overlap-free
rotation possible.

### Provisioning keys (per environment)

`keys/*.pem` is **gitignored and MUST be provisioned per environment** — never
ship the dev keypair to prod. Generate a fresh pair per environment:

```bash
# private (PKCS#8) + public (SubjectPublicKeyInfo) PEM
openssl genpkey -algorithm ed25519 -out keys/ed25519_private.pem
openssl pkey -in keys/ed25519_private.pem -pubout -out keys/ed25519_public.pem
chmod 600 keys/ed25519_private.pem
```

Mount these read-only into `auth-svc` (the compose file already does
`./keys:/keys:ro`) or, better, inject them from the secret manager (§1).

### Rotation procedure (overlapping JWKS publication)

Access tokens are short-lived (`JWT_ACCESS_TTL_SECONDS`, default 900s), so a full
rotation is bounded by one access-token TTL plus the JWKS cache TTL (~5 min).

> The shipped `auth-svc` serves a **single** active `kid` from its JWKS (one
> signing key in `keys/`). To overlap two `kid`s during a rotation window, run a
> short-lived **second `auth-svc` instance** that serves the *old* key while the
> primary serves the new one, OR extend `keys.py::jwks()` to emit both public
> keys. Steps below assume one of these so both `kid`s are published together.

1. **Generate** a new keypair with a NEW `kid` (e.g. `prod-ed25519-2`). Do not
   delete the old key yet.
2. **Publish both** public keys in the JWKS (new + old `kid`). Roll out the
   JWKS-serving change first and confirm `/.well-known/jwks.json` lists both.
3. **Bump `JWT_KID`** on `auth-svc` to the new `kid` and restart it. From now on
   new tokens are signed with the new key; tokens already issued under the old
   `kid` still verify because the old public key is still published.
4. **Wait out the overlap**: at least `JWT_ACCESS_TTL_SECONDS` + JWKS cache TTL
   (≈ 15 + 5 min) so every old-`kid` token has expired and every verifier has
   refreshed its JWKS.
5. **Retire the old key**: remove the old `kid` from the JWKS and delete the old
   private key from `keys/` / the secret manager.

Same procedure for an emergency revocation (suspected key compromise), but skip
the wait and accept that already-issued tokens are invalidated immediately.

---

## 5. Kafka — topics, replication & SASL_SSL

### Topic sizing

`infra/kafka/create-topics.sh` is env-driven:

- `REPLICATION_FACTOR` — **dev `1`; set `3` in prod.** RF cannot exceed the
  number of live brokers, so RF≥3 requires a **multi-broker** cluster (managed
  MSK/Confluent/Redpanda, or the Helm chart's Kafka StatefulSet). The
  single-broker Kafka in `docker-compose.prod.yml` is RF=1 and is **not** HA —
  run Kafka externally for production durability.
- `TOPIC_PARTITIONS` — baseline parallelism (default 12).
- `NOTIFICATION_PARTITIONS` — the high-fan-out `notification.events.v1` hot path;
  set **200+** in prod for consumer parallelism. Partitions can be increased
  online but never decreased — size up front.

### In-transit encryption + auth (SASL_SSL)

**Dev uses PLAINTEXT** (matches dev parity); the bundled single broker in
`docker-compose.prod.yml` is ALSO PLAINTEXT and is **not** the recommended prod
bus. For production, run an **external / multi-broker** cluster with a
**SASL_SSL** listener (TLS on the wire + SASL credential auth):

```
# Broker side (managed: configure in the MSK/Confluent/Redpanda console;
# self-hosted/Strimzi: set on the broker). Equivalent apache/kafka env:
KAFKA_LISTENERS=SASL_SSL://:9092,CONTROLLER://:9093
KAFKA_ADVERTISED_LISTENERS=SASL_SSL://<broker-host>:9092
KAFKA_INTER_BROKER_LISTENER_NAME=SASL_SSL
KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL
KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512
KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL=SCRAM-SHA-512
KAFKA_SSL_KEYSTORE_LOCATION=…  KAFKA_SSL_KEYSTORE_PASSWORD=…
KAFKA_SSL_TRUSTSTORE_LOCATION=…  KAFKA_SSL_TRUSTSTORE_PASSWORD=…
```

```
# Client side (in .env.prod — the producers/consumers):
KAFKA_BROKERS=<broker-host>:9092
KAFKA_SECURITY_PROTOCOL=SASL_SSL
KAFKA_SASL_MECHANISM=SCRAM-SHA-512
KAFKA_SASL_USERNAME=…   KAFKA_SASL_PASSWORD=…
KAFKA_SSL_CA_LOCATION=/etc/ssl/kafka/ca.crt
```

> **HONEST STATUS / code follow-up.** The in-tree Kafka clients —
> `aiokafka` in the Python services (`task-svc`, `email-worker`, etc.) and
> `segmentio/kafka-go` in `ws-gateway` — currently read **only** `KAFKA_BROKERS`.
> They do **not** yet pass `security.protocol` / `sasl.*` / TLS through to the
> client. Enabling SASL_SSL end-to-end therefore needs a small per-client change
> (aiokafka: `security_protocol="SASL_SSL", sasl_mechanism=…, ssl_context=…`;
> kafka-go: a `Dialer`/`Transport` with `SASLMechanism` + `TLS`). The broker
> recipe and the `KAFKA_SECURITY_*` env contract above (also stubbed in
> `.env.prod.example` and the Helm `values.yaml`) are shipped so the wiring is
> ready when that change lands. Until then keep the bundled broker on the
> **private compose network only** (it is never published off-host).

---

## 6. Redis — auth + TLS

The prod `redis` service ALWAYS runs with `--requirepass ${REDIS_PASSWORD}` (no
anonymous access on the shared network). `ws-gateway` and `email-worker` read
`REDIS_URL`; set the password in it.

**TLS (`rediss://`).** Prefer encrypting Redis traffic in prod. The honest
constraint: `ws-gateway` connects via go-redis `redis.ParseURL`, whose
`rediss://` path validates the server cert against the **system root CA store**
and does **not** load a private CA from the URL. So:

- **Managed Redis** (ElastiCache / Upstash / Redis Cloud) with a publicly-trusted
  cert → `rediss://:<pw>@host:6379/0` **just works** (verifying TLS). ✅ Recommended.
- **Self-signed Redis CA** → will NOT verify in `ws-gateway` without a code
  follow-up (inject `TLSConfig.RootCAs`). The compose ships a commented TLS recipe
  (`--tls-port` + certs from `scripts/gen-db-certs.sh REDIS=1`) for that path.
- **No TLS** → keep `redis://:<pw>@redis:6379/0` over the **private** bridge only.

`email-worker`'s redis client similarly honours `rediss://`; the same CA caveat
applies. The default `.env.prod.example` ships `rediss://` (assuming a managed,
publicly-trusted Redis) with the `redis://` fallback commented.

---

## 7. Host hardening: SSH + firewall

Apply the firewall first, then harden SSH. Keep one active session open while
testing so you can recover if a rule is wrong.

### Firewall baseline

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
sudo ufw status verbose
```

### SSH daemon checklist

Recommended `sshd_config` values for a key-based Ubuntu admin user:

```text
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers ubuntu
```

Rollout order:

1. Confirm you can log in as `ubuntu` with your SSH key in a second terminal.
2. Place the config in `/etc/ssh/sshd_config.d/99-hardening.conf`.
3. Run `sudo sshd -t` before restarting SSH.
4. Restart with `sudo systemctl restart ssh`.
5. Open a new SSH session and confirm it works before closing the old one.

If you use a non-default SSH port or a different admin user, update both the
firewall rule and `AllowUsers` before disabling password auth.

---

## 8. WAF (OWASP Core Rule Set) at the edge

The prod Caddy edge enforces a **Coraza** (ModSecurity-compatible) WAF running
the **OWASP Core Rule Set** — SQLi / XSS / RCE / LFI / protocol-anomaly detection
in front of every upstream.

### Custom Caddy build

Stock Caddy has no WAF, so the prod `caddy` service **builds a custom image**
(`infra/caddy/Dockerfile`): `xcaddy build --with
github.com/corazawaf/coraza-caddy/v2`. That module also **embeds the OWASP CRS**
(loaded via the `load_owasp_crs` directive). The WAF Caddyfile is
`infra/caddy/Caddyfile.waf`; the tuning files are mounted from
`infra/caddy/coraza/`:

- `coraza.conf` — engine config. **Currently `SecRuleEngine On` (blocking).** It
  originally shipped `DetectionOnly` so false positives could be watched against
  real traffic first; that is no longer the case, so a CRS false positive now
  returns 403 to real users. Check `SecRuleEngine` in the file itself rather than
  trusting this paragraph.
- `crs-setup.conf` — CRS knobs (anomaly threshold, paranoia level 1, allowed
  methods/content-types for a JSON API + SPA). **This file must stay in the
  `Include` list in `Caddyfile.waf`, after `@crs-setup.conf.example` and before
  `@owasp_crs/*.conf`.** It was silently absent until 2026-07-27, which left
  `tx.allowed_methods` at the CRS default of `GET HEAD POST OPTIONS` — every
  DELETE, PUT and PATCH was 403'd at the edge by rule 911100 and never reached a
  service. That reads like an application permissions bug, not a WAF one; if a
  write endpoint 403s, check `docker compose logs caddy | grep 911100` first.
- `rules/99-tuning.conf` — site-specific exceptions (e.g. skip the WAF for the
  static JWKS document and WebSocket upgrades). Local rule IDs use the
  1,000,000+ range so a CRS upgrade never clobbers them.

### Go-live procedure

1. Deploy with `SecRuleEngine DetectionOnly` (the default). Drive real traffic.
2. Watch `docker compose -f docker-compose.prod.yml logs caddy` for CRS hits
   (audit log → stderr). Add exceptions to `rules/99-tuning.conf` for any false
   positives (prefer per-path/per-param `ctl:ruleRemoveTargetById` over a blanket
   `SecRuleRemoveById`).
3. Once clean, set `SecRuleEngine On` in `coraza.conf` and redeploy → the WAF now
   **blocks**. Optionally raise `tx.blocking_paranoia_level` to 2 for deeper
   coverage (re-tune).

### Managed-WAF alternative (recommended at scale)

Put **Cloudflare WAF**, **AWS WAF** (on the ALB/CloudFront in front of the host),
or **Azure Front Door** ahead of the edge and enable their managed OWASP ruleset.
Then you can run the plain edge: swap the `caddy` service to
`image: caddy:2.8-alpine` + the stock `infra/caddy/Caddyfile` (drop `build:` and
the `Caddyfile.waf`/`coraza` mounts). The baseline Coraza ruleset shipped here
remains a portable, self-hosted fallback that needs no third party.

---

## 9. Quick checks

```bash
# Validate the prod compose before deploying (use the example env to satisfy
# interpolation if .env.prod isn't on this box yet).
docker compose -f docker-compose.prod.yml --env-file .env.prod.example config -q

# Generate dev/staging DB TLS certs (and verify the chain).
scripts/gen-db-certs.sh
openssl verify -CAfile infra/postgres/certs/ca.crt infra/postgres/certs/server.crt

# Confirm Postgres is actually serving TLS (inside the compose network):
#   psql "postgresql://auth_user:***@postgres:5432/authdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt" -c '\conninfo'
# → should report "SSL connection (protocol: TLSv1.3, …)".

# Confirm the WAF is compiled into the edge image:
docker compose -f docker-compose.prod.yml build caddy
docker compose -f docker-compose.prod.yml run --rm --no-deps caddy caddy list-modules | grep coraza

# Readiness of each HTTP service (through Caddy or on the internal network).
for p in 8001 8002 8003 8004 8080; do curl -fsS localhost:$p/readyz && echo " $p OK"; done

# JWKS sanity (should list the active kid, and during rotation both kids).
curl -fsS https://$DOMAIN/.well-known/jwks.json | jq '.keys[].kid'
```
