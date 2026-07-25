# Deploy runbook — External Integrations + forward-tracking (Enterprise plan)

Branch: `external-integrations`. Adds `integrations-svc` (:8005, `integrationsdb`),
message forward-tracking in `messaging-svc`, an org **plan** entitlement in
`auth-svc`, and desktop auto-update. **This is an enterprise-plan feature** — it is
invisible + 403-gated for non-enterprise orgs.

> Prod runs `docker-compose.prod.yml` with `TB_ENV=production`. The prod host
> rootfs is **read-only** — pipe scripts in via `stdin`, never `docker cp`
> (see docs/BACKUPS.md). Do every step in a maintenance window; there are real users.

---

## 0. Pre-flight (do NOT skip)

```bash
# On the prod host, from the repo root.
git fetch && git checkout external-integrations

# Full encrypted backup of ALL service DBs FIRST (now includes integrationsdb,
# which won't exist yet — that's fine, it's skipped until created).
BACKUP_ENCRYPTION_KEY="$(cat /home/ubuntu/bliss-backup-key.txt)" bash scripts/backup-db.sh
```

Confirm the new dumps land in `backups/*.sql.enc` before continuing.

---

## 1. Provision `integrationsdb` + least-priv role (existing volume)

The `infra/postgres/init/*` scripts only run on a **fresh** pgdata volume, so on the
live DB you create the database + role by hand. Pick a **strong** password and use
the SAME value in `INTEGRATIONS_DB_PASSWORD` + `INTEGRATIONS_DATABASE_URL` (step 2).

```bash
INTPW="$(openssl rand -hex 24)"; echo "INTEGRATIONS_DB_PASSWORD=$INTPW"   # save this
# Pipe SQL in via stdin (read-only rootfs). $POSTGRES_USER is the superuser.
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE integrationsdb;"
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d integrationsdb -c "CREATE EXTENSION IF NOT EXISTS citext;"
docker compose -f docker-compose.prod.yml exec -T -e INTPW="$INTPW" postgres sh -c '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
    -c "DROP ROLE IF EXISTS integrations_user; CREATE ROLE integrations_user LOGIN PASSWORD '"'"'"$INTPW"'"'"';" \
    -c "REVOKE ALL ON DATABASE integrationsdb FROM PUBLIC;" \
    -c "GRANT CONNECT ON DATABASE integrationsdb TO integrations_user;"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d integrationsdb \
    -c "GRANT ALL ON SCHEMA public TO integrations_user; ALTER SCHEMA public OWNER TO integrations_user;"
'
```

`integrations-svc` runs its own migrations (`0001_init`, `0002_rls`) on boot as
`integrations_user`, and RLS FORCE applies to the owner — so per-org isolation
enforces (verified: wrong-org/no-context → 0 rows).

---

## 2. Environment (`.env`, gitignored)

Set on the prod host (values already scaffolded on the working branch; **replace the
dev DB password with the real one from step 1**):

```
INTEGRATIONS_DB_PASSWORD=<the strong password from step 1>
INTEGRATIONS_DATABASE_URL=postgres://integrations_user:<same-password>@postgres:5432/integrationsdb?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
INTEGRATIONS_PORT=8005
PUBLIC_BASE_URL=https://communication.rnrtechs.com          # OAuth callbacks + webhooks
VITE_INTEGRATIONS_BASE=https://communication.rnrtechs.com/api/integrations
# Optional (Slack inbound webhooks): the Slack app's signing secret.
SLACK_SIGNING_SECRET=<from your Slack app>                  # leave blank until you connect Slack
```

`integrations-svc`'s prod validator will refuse to start if any of `PUBLIC_BASE_URL`,
`TB_INTERNAL_TOKEN`, a `verify-full` DB URL, or non-dev crypto secrets are missing.
The web build **requires** `VITE_INTEGRATIONS_BASE` (fail-fast) — set it before
`npm run build`.

---

## 3. Apply the auth-svc plan migration + Caddy routes

- `auth-svc` runs `migrations/0006_org_plan.sql` automatically on restart (adds
  `orgs.plan DEFAULT 'free'`). No manual step; just redeploy auth-svc (step 4).
- Caddy routes for `/api/integrations/*` (JWT) and public `/ext/*` (webhooks/OAuth)
  are already in `infra/caddy/Caddyfile` + `Caddyfile.waf`. Rebuild/reload Caddy in
  step 4. If the WAF 403s legit `/ext/*` provider payloads, add a scoped
  `ctl:ruleRemoveById` in `infra/caddy/coraza/rules/*.conf` keyed on `REQUEST_URI "^/ext/"`.

---

## 4. Build + deploy

```bash
# Build the new image + rebuild changed services (auth-svc, messaging-svc, caddy, web).
docker compose -f docker-compose.prod.yml build integrations-svc auth-svc messaging-svc caddy web-builder
docker compose -f docker-compose.prod.yml up -d integrations-svc auth-svc messaging-svc caddy
# (web is served by nginx from web-builder output — redeploy per your existing web flow.)
```

Health-check:

```bash
for p in 8001 8004 8005; do
  docker compose -f docker-compose.prod.yml exec -T $( [ $p = 8005 ] && echo integrations-svc || [ $p = 8004 ] && echo messaging-svc || echo auth-svc ) \
    sh -c "python -c \"import urllib.request;print(urllib.request.urlopen('http://localhost:$p/readyz').read())\" 2>/dev/null || wget -qO- http://localhost:$p/readyz"
done
# Edge: /api/integrations should reach the service (401 without a token is expected/good).
curl -s -o /dev/null -w '%{http_code}\n' https://communication.rnrtechs.com/api/integrations
```

---

## 5. Grant an org the Enterprise plan

The feature stays hidden + 403 until an org is on `enterprise`. There's no self-serve
billing yet — set it directly:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d authdb -c "UPDATE orgs SET plan='enterprise' WHERE slug='<org-slug>';"
```

Takes effect on that org's next token refresh (≤ the access-token TTL). Users then see
the **Integrations** rail item + the message **Forward** action.

> `scripts/rewrap-crypto-keys.py` now includes `integrationsdb` in `REWRAP_DBS` — this
> matters only for a FUTURE master-key rotation, not this deploy (fresh per-org DEKs are
> created lazily on first write).

---

## 6. Desktop `.exe` auto-update

Auto-update targets the **NSIS** build via GitHub releases (`SiddhantSShende/Bliss-Work`);
the Microsoft Store (AppX/MSIX) build updates through the Store and is skipped.

To ship an update:
1. Bump `apps/desktop/package.json` `version`.
2. Build + publish signed artifacts to a GitHub release:
   ```bash
   npm run build -w @taskboard/desktop   # or your existing desktop build script
   # electron-builder publishes to the configured GitHub repo when GH_TOKEN is set
   # and the release is created. Code-sign per apps/desktop/SIGNING.md — an unsigned
   # NSIS build will trigger SmartScreen warnings and a poorer update UX.
   ```
3. Installed clients call `autoUpdater.checkForUpdates()` on launch, download in the
   background, and prompt to restart when ready (`src/main/updater.ts`).

---

## 7. Rollback

```bash
git checkout main
docker compose -f docker-compose.prod.yml up -d auth-svc messaging-svc caddy
docker compose -f docker-compose.prod.yml stop integrations-svc
# orgs.plan + integrationsdb are additive and harmless if integrations-svc is stopped;
# forward endpoints simply 404 again on the old messaging-svc image. Restore from the
# step-0 backup only if a data issue is found.
```

---

## Scope note (WhatsApp)

Forward-tracking is **internal-relay only** — it records forwards done *through*
Bliss-Work + logs outbound forwards to external platforms. Detecting a forward that
happens *natively inside* someone's personal WhatsApp/Gmail/etc. is not possible via
any API on any plan (E2E-encrypted, not exposed to third parties), and the covert
device-agent route is out of scope (spyware-class; ToS/interception-law exposure).
