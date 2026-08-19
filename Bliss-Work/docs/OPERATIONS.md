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

### Load balancing and scaling out

Caddy is also the load balancer. It does not hold a list of backend addresses:
each `reverse_proxy` resolves a **compose service name** on a 10s timer
(`dynamic a` in `infra/caddy/Caddyfile*`), and Docker's embedded DNS answers
that name with the address of every container behind it. Requests are then
spread with `least_conn`.

`docker-compose.prod.yml` runs **two replicas** of each stateless HTTP service
(`auth-svc`, `task-svc`, `notification-svc`, `messaging-svc`,
`integrations-svc`, `telemetry-svc`). To add capacity for a busy period:

```bash
docker compose -f docker-compose.prod.yml up -d --scale task-svc=4
```

No edge config change and no reload — the new containers start taking traffic
within ~10s. Scaling back down is the same command with a lower number.

Three limits to know before turning the dial:

- **Postgres connection slots are the real ceiling.** Each replica of a service
  opens up to 10 backends, so the fleet costs `10 x replicas` per service
  against `max_connections=200`. Two replicas each = 128 in use. Past roughly
  four each you need PgBouncer, which means the Helm path — see
  `INFRASTRUCTURE.md`.
- **`ws-gateway` is not `--scale`-able.** Each gateway publishes
  `WS_ADVERTISE_ADDR` to Redis as "how to reach the node holding this socket",
  and in compose that is the service name — which under replicas resolves to all
  of them, so a cross-node push lands on a gateway that does not hold the
  socket. Broadcast fan-out also keys each gateway's Kafka group to its
  hostname, which churns on every recreate. A gateway fleet means
  `WS_FANOUT_MODE=routed` plus `delivery-svc` (compose profile `routed`) and a
  per-replica advertise address.
- **Health checking at the edge is passive**, because Caddy does not actively
  probe dynamically-resolved upstreams. A replica is ejected after two failures
  and retried 30s later, and a request that hits a refused connection is
  re-dispatched to another replica rather than returned as a 502. `/readyz`
  still gates compose dependency ordering; it is simply no longer polled by
  Caddy.

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

> **`server.key` must be `0600` and owned by uid 70.** The bind mount passes the
> host uid straight into the container, and Postgres refuses to start on anything
> else:
>
> | ownership | result |
> |---|---|
> | `70:70` mode `600` | ✅ starts |
> | `1000:1000` mode `600` | ❌ `FATAL: private key file … must be owned by the database user or root` |
> | `root:root` mode `600` | ❌ passes the ownership check, then `could not load private key file: Permission denied` |
>
> `gen-db-certs.sh` sets this, but **anything that rewrites ownership across the
> repo** (a broad `chown -R`, an rsync, a restore from backup) silently breaks it.
> It is a *dormant* failure: Postgres reads the key only at startup, so a running
> server keeps serving and the box only falls over at the next restart, deploy, or
> reboot — potentially weeks later, and nowhere near the change that caused it.
> Check it whenever certs or repo permissions are touched:
>
> ```bash
> ls -ln infra/postgres/certs/server.key   # want: -rw------- 1 70 70
> sudo chown 70:70 infra/postgres/certs/server.key && sudo chmod 600 $_
> ```

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

> **STATUS: wired.** Every Kafka client in the platform reads the variables
> above — all 17 of them, across 8 services, which is rather more than the
> "five call sites" an earlier note estimated:
>
> * **Go** (`messaging-svc`, `ws-gateway`, `notification-svc`) via
>   `internal/kafkaauth`, which builds a `Dialer` for every `kafka.NewReader`
>   and a `Transport` for every `kafka.Writer`.
> * **Python** (`auth-svc`, `task-svc`, `integrations-svc`, `telemetry-svc`,
>   `email-worker`) via `app/kafka_security.py`, whose `kafka_security_kwargs()`
>   is splatted into every `AIOKafkaProducer` / `AIOKafkaConsumer`.
>
> Leaving `KAFKA_SECURITY_PROTOCOL` unset keeps everything on PLAINTEXT, so the
> bundled broker is unaffected. Setting it to a SASL value **without**
> credentials is a startup error rather than a silent fallback — a client that
> quietly reverted to plaintext would be a deployment that believes it is
> authenticated and is not. Each service logs its resolved protocol at boot.
>
> `KAFKA_SASL_MECHANISM` accepts `PLAIN`, `SCRAM-SHA-256` and `SCRAM-SHA-512`
> and defaults to `PLAIN`. **MSK IAM auth is not supported** — it needs a
> separate signer and the AWS credential chain; use SCRAM-SHA-512 on MSK.
> `KAFKA_SSL_CA_LOCATION` is only needed for a private CA; the system roots are
> used when it is unset.
>
> Until you actually move off it, keep the bundled broker on the **private
> compose network only** (it is never published off-host).

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

That leaves **22, 80, 443 (+ 3478 and 49160-49200 for coturn, and 50000-50200/udp
plus 7881/tcp for the LiveKit SFU)** reachable — plus **5432**, which is
host-published for DB admin access and gated separately; see below.

`infra/host/harden-host.sh` installs all of these. The two media ranges are not
optional if you run calls, and they fail in a way that does not look like a
firewall problem: with the UDP range closed, a call **connects, shows every
participant, and carries no audio or video**. The TCP port is the fallback for
clients on networks that block UDP outright. LiveKit's signaling port (7880) is
deliberately *not* opened — its only public door is the TLS-terminated
`/livekit` route through Caddy.

### Direct Postgres access (5432)

`docker-compose.prod.yml` publishes postgres as `0.0.0.0:5432:5432` so you can
attach `psql` or a GUI client (DBeaver / pgAdmin / TablePlus) without shelling
into the container.

> **ufw does not protect this port.** Docker's DNAT and FORWARD rules are
> evaluated *before* ufw's chains, so `default deny incoming` has no effect on a
> published port. The gate is a source-IP allowlist in the `DOCKER-USER` chain —
> the one hook that runs ahead of Docker's own ACCEPT.

Install it **before** the container is created, and re-run it whenever your ISP
rotates your address:

```bash
sudo bash infra/host/db-allowlist.sh                    # current default allowlist
sudo bash infra/host/db-allowlist.sh 203.0.113.7/32     # after an IP change
```

The script persists its rules in `/etc/ufw/after.rules`, so they survive
`ufw reload` and reboot. Verify from an address that is *not* on the allowlist —
it must time out, not connect and not refuse:

```bash
nc -vz -w 5 <host> 5432     # expected: timeout;  nmap -Pn -p 5432 → filtered
```

#### Connecting from the VPS itself

The allowlist does not apply here (host-local traffic never crosses `FORWARD`),
and `verify-full` works because the server cert's SAN covers `IP:127.0.0.1`:

```bash
psql "postgresql://taskboard@127.0.0.1:5432/postgres?sslmode=verify-full&sslrootcert=infra/postgres/certs/ca.crt"
```

#### Connecting from a workstation

Copy the CA down once, then use `verify-ca`:

```bash
scp <host>:BlissWork/Bliss-Work/infra/postgres/certs/ca.crt ~/blisswork-db-ca.crt
psql "postgresql://taskboard@<host>:5432/postgres?sslmode=verify-ca&sslrootcert=$HOME/blisswork-db-ca.crt"
```

In a GUI client: SSL mode `verify-ca`, root certificate `~/blisswork-db-ca.crt`.

`verify-full` **fails** from a workstation — the leaf cert's SAN is
`DNS:postgres, DNS:localhost, IP:127.0.0.1` and does not include the host's
public address. `verify-ca` still validates the chain against your private CA and
only skips the hostname check. To get `verify-full` off-box you would have to
re-issue the leaf with the public IP/domain in its SAN (the CA, and therefore
every service's `sslrootcert`, can stay as-is).

#### Which role to connect as

Credentials live in `.env.prod` (gitignored). `POSTGRES_USER` / `POSTGRES_PASSWORD`
is the **superuser**: it reaches every database, and it **bypasses Row-Level
Security**. Use it for schema inspection and ops, but never to sanity-check
per-org isolation — RLS will appear to be off. For that, connect as the
per-service role that the app actually uses (`auth_user` → `authdb`,
`task_user` → `taskdb`, …, created in `infra/postgres/init/02-create-roles.sh`)
with the matching `*_DB_PASSWORD`.

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

## 9. Mail

### Outbound

messaging-svc queues one `mail.outbound` event per external addressee and
`email-worker` relays it, using the same `SMTP_*` credentials as the invite and
notification mail. No extra configuration is needed for it to send.

**Attachments** ride as MIME parts. The bytes are NOT on the Kafka event — the
broker's default message cap is 1 MB and a mail to five external addresses would
carry five copies of every file — so the event names them and email-worker
fetches each one from `GET /internal/mail/{mailId}/attachments/{id}` on
messaging-svc, which is the service the `media_blobs` volume is mounted into.
That endpoint takes the shared `TB_INTERNAL_TOKEN` and, like every other
`/internal/` path, is 404'd at the edge — it must stay unreachable from outside.

`MAIL_ATTACHMENT_BUDGET_BYTES` (default 10 MiB) caps the RAW bytes carried on one
email. Base64 adds about a third, so the default lands near 13.6 MB on the wire,
under the 25 MB Gmail accepts and the 20 MB or less common elsewhere. Uploads
themselves are capped by `MEDIA_MAX_BYTES` (100 MB), so a file can legitimately
be far too large to email: those are NAMED in the message rather than dropped
silently, and the in-app copy still carries every one. Raise the budget only as
far as your provider and your recipients' will accept — a message over the limit
is rejected at the far end, not truncated.

Getting it *accepted* is a DNS question, because a member's mail goes out under
the member's own identity:

| | invite / reset / notification mail | mail a member composed |
|---|---|---|
| `From:` header | `SMTP_FROM` | the member's name and account address |
| SMTP envelope sender | `SMTP_FROM` | `SMTP_FROM` |

The envelope is what your relay authorises and what **SPF** is checked against,
so it stays on `SMTP_FROM` in both cases and both pass SPF.

**DMARC is the part that needs a decision.** DMARC asks whether the `From:`
DOMAIN authorised this deployment, and it is satisfied by either SPF or DKIM
being *aligned* with that domain. For member mail the From domain is the
member's, not `SMTP_FROM`'s, so:

- **Members on a domain you control** (the usual case — everyone is
  `@yourcompany.com`): publish the SPF include and the DKIM key your provider
  gives you on that domain, and member mail is fully aligned. Nothing else to do.
- **Members on domains you do not control**: their mail is unaligned. A domain
  publishing `p=none` still delivers; `p=quarantine` or `p=reject` will not.
  Either have those domains authorise your provider, or accept that mail from
  them lands in spam.

Check what a domain currently publishes before assuming, e.g.
`dig +short TXT _dmarc.example.com`.

### Inbound

There are two ways mail gets INTO a BlissWork inbox, and a deployment can use
either, both, or neither. A deployment does not terminate SMTP itself.

#### 1. Mirroring a connected mailbox (no infrastructure)

When a member connects Outlook under **Integrations**, integrations-svc already
walks their inbox for mention detection. Every mail that is new to it is now also
delivered into their BlissWork inbox — see `app/mail_bridge.py`. The mail stays
in Outlook exactly as before; BlissWork receives a copy.

What an operator has to do:

1. **Register a Microsoft Entra app for the org** and enter its client id/secret
   under Integrations → app credentials. Each org brings its own app; there is no
   central BlissWork app to consent to. The Outlook connection requests
   `Mail.Read` and `Mail.Send`.
2. **Have each member connect Outlook.** The mirror is per-connection: it can
   only read a mailbox somebody has authorised.

Then it runs on its own — the push subscription wakes the sweep, and the sweep
reconciles anything a missed notification would have dropped.

Notes:

- **Dedup is on the RFC 5322 `Message-ID`**, not the per-mailbox Graph id. Two
  colleagues who both connect Outlook and were both on one mail get ONE
  conversation in BlissWork, delivered to both.
- **Mail addressed to nobody in the org is dropped** (messaging-svc answers 422
  and the bridge logs it at info). Most of a real mailbox is exactly that, so
  this is the ordinary path, not an error.
- **Gmail is not mirrored yet.** The Gmail connection ingests for mentions as
  before. Graph hands us a parsed message; Gmail returns a raw MIME payload that
  has to be decoded first, which is the piece still to write.
- A mail that cannot be delivered is logged and skipped, never retried into a
  stall — it is still in the member's real mailbox, and blocking the sweep would
  hold up every message behind it.

#### 2. Terminating SMTP yourself (whole domain, no per-user OAuth)

Point a domain's MX at whatever parses mail for you and have it POST the parsed
result to the ingestion endpoint below. This is what to use when BlissWork should
be the real mailbox for an address rather than a copy of one.

```
POST http://messaging-svc:8004/internal/mail/inbound
X-Internal-Token: $TB_INTERNAL_TOKEN
Content-Type: application/json

{ "orgId": "<uuid>", "externalMessageId": "<RFC 5322 Message-ID>",
  "fromAddress": "sender@outside.example", "fromName": "Sender Name",
  "subject": "...", "bodyText": "...", "bodyHtml": "",
  "to": ["colleague@yourdomain"], "cc": [], "sentAt": "2026-08-18T09:00:00Z" }
```

Notes for whoever wires this up:

- **The contract is parsed mail, not raw MIME.** MIME parsing belongs in the
  component that already has to do it (your provider's webhook, an LMTP shim, a
  fetch job), and keeping it out of messaging-svc means the service never parses
  a byte stream from the internet.
- **Auth is the shared `TB_INTERNAL_TOKEN`**, the same secret ws-gateway and
  task-svc use for their internal calls. The route sits outside `/api/v1`, so it
  has no JWT middleware and no CORS, and it must NOT be published through Caddy.
  It is reachable only from inside the deployment network.
- **`externalMessageId` is the dedup key** and is required. Webhooks retry, and
  a mail delivered twice is worse than one delivered late. A repeat answers
  `200 {"duplicate": true}` — deliberately not an error, because a retrying
  sender treats anything but success as "try again".
- **Addresses that do not resolve to an active member of `orgId` are dropped.**
  If none resolve, the request is rejected (422) rather than storing a mail
  nobody can ever see. This endpoint delivers into BlissWork mailboxes; it does
  not relay onward.

---

## 10. Quick checks

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

# Confirm the fleet is actually multi-replica, and that the edge can see every
# member (the second command must list one IP per running container).
docker compose -f docker-compose.prod.yml ps --format '{{.Service}}\t{{.Name}}\t{{.Status}}'
docker compose -f docker-compose.prod.yml exec caddy nslookup task-svc

# JWKS sanity (should list the active kid, and during rotation both kids).
curl -fsS https://$DOMAIN/.well-known/jwks.json | jq '.keys[].kid'
```
