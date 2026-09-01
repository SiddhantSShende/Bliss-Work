# Deploying BlissWork

How code gets from a commit to production and to users' desktops.

For connecting external platforms see [`INTEGRATIONS-SETUP.md`](INTEGRATIONS-SETUP.md);
for backups, key rotation and the WAF see [`OPERATIONS.md`](OPERATIONS.md).

## The pipeline

All four workflows below live in `.github/workflows/` at the **monorepo root**
(not inside `Bliss-Work/` or `Bliss-Website/`) — GitHub Actions only ever
discovers workflows there. Each is a separate, directly push-triggered job;
only `deploy-prod.yml` additionally waits on CI.

```
                          push to Prod-Sid
                                │
        ┌───────────┬──────────┼──────────────┐
        ▼           ▼          ▼              ▼
 ┌─────────────┐ ┌─────────┐ ┌──────────────┐ ┌────────────────┐
 │  CI (ci.yml)│ │release  │ │ deploy-site  │ │ (deploy-prod    │
 │  lint·test  │ │.yml     │ │ .yml         │ │  waits below)   │
 │  go -race   │ │build    │ │ ssh → VPS    │ └────────────────┘
 │  trivy·e2e  │ │win/mac/ │ │ deploy-site  │
 └──────┬──────┘ │linux    │ │ .sh          │
        │success │sign     │ └──────┬───────┘
        ▼        │manifest │        ▼
 ┌──────────────┐└────┬────┘  marketing site live at
 │deploy-prod   │     ▼       blisswork.rnrtechs.com
 │.yml          │  rsync → /downloads/
 │ssh → VPS     │  ↳ installers + latest*.yml
 │deploy-prod.sh│  ↳ electron-updater feed
 └──────┬───────┘       │
        ▼               ▼
 web app + 7 services   installed apps self-update
 live at communication  on next launch
 .rnrtechs.com
```

Nothing deploys from a feature branch or a pull request. `workflow_run` never
fires for `pull_request` events, and `deploy-prod.yml` is gated on
`conclusion == 'success'`, so a red CI run leaves it **skipped**. `release.yml`
and `deploy-site.yml` are NOT gated on CI — they fire directly on push, so a
release or site deploy is never blocked by an unrelated CI failure elsewhere in
the monorepo. (`release.yml` used to be CI-gated too, back when `ci.yml` was
never discovered at all and the gate could never fire; see the comment in
`release.yml` for why that gate was not reinstated once `ci.yml` was fixed.)

## Web app + backend

`.github/workflows/deploy-prod.yml` carries the SSH key and nothing else. All the
logic is in **`scripts/deploy-prod.sh`**, in the repo, so a deploy is reviewable
in a PR and reproducible by hand when GitHub is down.

What the script does, in order:

1. **Guards.** Refuses to run unless the checkout is on `Prod-Sid` with a clean tree.
2. **Fast-forwards** to `origin/Prod-Sid` (never `reset --hard`, never a merge commit).
3. **Tags images with the commit SHA** — `IMAGE_TAG=$(git rev-parse --short HEAD)`,
   exported so it wins over the value in `.env`. The previous image set stays in
   the local store, which is what makes rollback fast.
4. **Builds and rolls** `CORE_SERVICES` — the application + its infra (postgres,
   redis, kafka, livekit, coturn, the 8 app services, graph-gw, caddy, nginx) —
   via `compose up -d`, explicitly scoped to that list rather than the whole
   compose file. The observability stack (prometheus, grafana, loki, tempo,
   otel-collector, alertmanager, 3 exporters, cadvisor) declares no `profiles:`,
   so an unscoped `up -d` would sweep it into every application deploy; naming
   `CORE_SERVICES` explicitly leaves it untouched. Each app service runs its own
   migrations at boot, so there is no separate migration step.
5. **Rebuilds the web bundle** via the one-shot `web-builder`, then force-recreates
   `nginx`. `index.html` is served `no-cache`, so browsers pick the new bundle up
   on their next load — that is the web app's "auto-update".
6. **Waits for healthchecks** on all seven health-declaring services, then makes
   one HTTPS request to the site.
7. **Rolls back automatically** if any of that fails: back to the previous commit
   and the previous image tag, then exits non-zero so the job goes red.
8. **Prunes** all but the 3 most recent image tags per service.

Compose is always called with **both** `--env-file .env --env-file .env.prod`.
`.env` alone is not enough: `${LIVEKIT_API_KEY}` / `${LIVEKIT_API_SECRET}` are
interpolated directly into livekit's `LIVEKIT_KEYS` in `docker-compose.prod.yml`
and exist only in `.env.prod` — with `.env` alone that resolves to `": "` and
LiveKit authenticates nobody.

### The clean-tree guard, and why it exists

`/home/ubuntu/BlissWork/Bliss-Work` is simultaneously your working copy **and**
production's docker build context. There is no separate deploy checkout, because
a second clone would spawn a second compose project with its own volumes.

So a deploy that blindly synced to `origin/Prod-Sid` would either destroy uncommitted
work or ship something nobody reviewed. The script fails closed instead. If you
see

```
✗ Refusing to deploy: the working tree has 65 uncommitted change(s)
```

that is the guard working. Commit or merge the branch; don't reach for the
override.

`DEPLOY_ALLOW_DIRTY=1` exists for deliberate hand-deploys of a branch. **Never set
it in CI** — it disables the only thing standing between an unreviewed working
tree and production.

### Manual deploy and rollback

```bash
# Normal deploy, by hand
bash scripts/deploy-prod.sh

# Deploy the current (possibly dirty, possibly non-Prod-Sid) tree — you own this
DEPLOY_ALLOW_DIRTY=1 bash scripts/deploy-prod.sh

# Roll back to a specific previous release without rebuilding
docker images 'task-board/auth-svc'          # find the tag you want
IMAGE_TAG=<sha> docker compose -f docker-compose.prod.yml up -d
IMAGE_TAG=<sha> docker compose -f docker-compose.prod.yml run --rm web-builder
docker compose -f docker-compose.prod.yml up -d --force-recreate nginx
```

Confirm what is actually live from **Settings → About** in the app, which shows
the deployed commit SHA (`VITE_BUILD_SHA`, injected by `web-builder`). A page that
still says the old SHA means the browser is on a cached bundle, not that the
deploy failed.

### Confirming what's actually deployed

Two housekeeping fixes plus one new signal make it possible to trace a
running container back to the commit that produced it.

**Only one `.github/workflows/` directory is ever live.** GitHub Actions
discovers workflows exclusively at the monorepo root (see "The pipeline"
above). A second, stale copy of six workflows (`build-images.yml`,
`codeql.yml`, `loadtest-gate.yml`, `security-extra.yml`, `store-build.yml`,
`store-release.yml`) used to sit one directory too deep, in
`Bliss-Work/.github/workflows/` — GitHub had never once discovered or run
them from there. That copy has been deleted; a workflow that needs to exist
belongs at the repo root, next to the four that are actually live.

**The Jenkins pipeline's branch guard now matches the real branch.**
`Jenkinsfile`'s `RELEASE_BRANCH` was hard-coded to `main`, a branch that has
never existed on this remote (`git ls-remote --heads origin` lists only
`Prod-Sid` and `VPS-Shristi`) — the "Validate Branch" stage would have
refused every build. It now checks `Prod-Sid`, the branch production
actually deploys from. Note that Jenkins and the GitHub Actions pipeline
above are two independent pipelines, either of which can build and push
images — reconciling that overlap is a separate, unresolved question.

**`/healthz` reports the deployed `IMAGE_TAG`.** Every backend service
returns its running image tag alongside the liveness check, e.g.:

```json
{"status": "ok", "version": "43da7d0"}
```

`docker-compose.prod.yml` sets `IMAGE_TAG: ${IMAGE_TAG:-dev}` explicitly in
each app service's `environment:` block. That override matters: without it, a
container would instead inherit the *static* `IMAGE_TAG=latest` that
`.env.prod` supplies via `env_file`, which does not track what is actually
running. `scripts/deploy-prod.sh` exports the real commit SHA before calling
`compose up`, so on a healthy deploy `version` matches `git rev-parse
--short HEAD` for that commit.

To confirm a deploy, curl each service through its public `/api/<svc>/*`
prefix (see `infra/caddy/Caddyfile`'s routing table) and compare `version`
against the commit you expect:

```bash
curl https://communication.rnrtechs.com/api/auth/healthz
curl https://communication.rnrtechs.com/api/tasks/healthz
curl https://communication.rnrtechs.com/api/notifications/healthz
curl https://communication.rnrtechs.com/api/messaging/healthz
curl https://communication.rnrtechs.com/api/integrations/healthz
curl https://communication.rnrtechs.com/api/telemetry/healthz
```

`ws-gateway`, `delivery-svc` and `graph-gw` are not proxied under `/api/*` —
their `/healthz` (like everyone's `/metrics` and `/internal/*`) is reachable
only from inside the compose network, e.g.:

```bash
sudo docker compose -f docker-compose.prod.yml exec ws-gateway wget -qO- http://localhost:8080/healthz
```

## Desktop app

`.github/workflows/release.yml` builds on all three native runners, signs, and
rsyncs to `/home/ubuntu/BlissWork/downloads` on the VPS, which nginx serves at
`/downloads/` for both `communication.rnrtechs.com` and `blisswork.rnrtechs.com`.

That directory is owned by the release pipeline and nothing else. It deliberately
sits **outside** any build output: it used to be `Bliss-Website/dist/downloads`,
and because `dist/` is Vite output that `npm run build` empties, every rebuild of
the marketing site wiped the entire installer set and update feed. If you ever
repoint it, keep that property — and update the `VPS_PATH` secret, the nginx
bind-mount in `docker-compose.prod.yml`, and nothing else.

**Versioning is automatic.** Every push to `Prod-Sid` publishes
`0.1.<github.run_number>`. `run_number` only ever increases, so each release
compares greater than the last, which is the only reason electron-updater sees an
update at all. `scripts/set-desktop-version.mjs` stamps it at build time and
deliberately does **not** commit the bump back — that would retrigger CI, which
would retrigger the release, forever. The repo therefore stays at `0.1.0`; a
locally-packaged build is always `0.1.0` and always thinks an update is available,
which is correct, because it is not a release.

Pushing a `v1.2.3` tag publishes that exact version instead.

### The update feed

`/downloads/` **is** the feed. `apps/desktop/package.json` declares
`publish: { provider: generic, url: https://communication.rnrtechs.com/downloads }`,
electron-builder bakes that into `app-update.yml` inside the package, and
`apps/desktop/src/main/updater.ts` polls it on launch.

It has to be a generic feed rather than GitHub Releases because **this repo is
private** — a GitHub feed needs a token, and a token shipped inside an installer
is a token anyone can extract.

Three things are load-bearing and fail *silently* if broken, so each has a guard:

| Requirement | What breaks without it | Guard |
|---|---|---|
| `latest*.yml` uploaded with the installers | Feed 404s; no update ever offered, no error shown | `Verify update manifests exist` step fails the build |
| Windows `sha512` recomputed **after** signing | Every download fails its integrity check at the last moment | `scripts/regen-update-manifest.mjs`, run unconditionally |
| Manifests served `no-cache` | Users sit up to an hour behind a release | Exact-match locations in `infra/nginx/default.conf` |

Installers keep the 1-hour cache — they are immutable per version, and the 110 MB
transfer is the expensive part.

### Microsoft Store builds are not covered

`updater.ts` early-returns on `process.windowsStore`: the Store manages those
updates and electron-updater cannot self-install an MSIX. Store releases stay
tag-driven (`store-v*` → `store-release.yml`) because submissions go through
certification. **Store users will lag direct-download users**, by however long
review takes.

## Repository secrets

| Secret | Used by | Required? | If absent |
|---|---|---|---|
| `VPS_HOST` | deploy-prod, release | **Yes** | Both deploys skip cleanly; CI still passes |
| `VPS_USER` | deploy-prod, release | **Yes** | — |
| `VPS_SSH_KEY` | deploy-prod, release | **Yes** | — |
| `VPS_PATH` | release | **Yes** | Installer rsync has no destination |
| `VPS_REPO_DIR` | deploy-prod | No | Defaults to `/home/ubuntu/BlissWork/Bliss-Work` |
| `ES_USERNAME`, `ES_PASSWORD`, `ES_CREDENTIAL_ID`, `ES_TOTP_SECRET` | release | No | Windows installer ships **unsigned** (SmartScreen warnings) |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | release | No | macOS build ships unsigned |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | release | No | macOS build is not notarized |
| `STORE_IDENTITY_NAME`, `STORE_PUBLISHER_ID` | store-release | No | Store workflow hard-fails |
| `AZURE_STORE_TENANT_ID`, `AZURE_STORE_CLIENT_ID`, `AZURE_STORE_CLIENT_SECRET`, `STORE_APP_ID` | store-release | No | `.appx` is built but not submitted |

The pipeline is safe to merge before any of these exist — every stage that needs a
secret is gated on its presence.

### Setting up the deploy key

One key serves both workflows. On the VPS:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/blisswork_deploy -N ""
cat ~/.ssh/blisswork_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

cat ~/.ssh/blisswork_deploy      # ← the PRIVATE half; paste into VPS_SSH_KEY
rm ~/.ssh/blisswork_deploy       # GitHub is now the only copy
```

Then in **Settings → Secrets and variables → Actions**, add:

| Name | Value |
|---|---|
| `VPS_HOST` | the server's IP or hostname |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | the full private key, `-----BEGIN` through `-----END` inclusive |
| `VPS_PATH` | `/home/ubuntu/BlissWork/downloads` |

Verify before relying on it:

```bash
# From your laptop, with the private key
ssh -i /path/to/key ubuntu@$VPS_HOST 'bash /home/ubuntu/BlissWork/Bliss-Work/scripts/deploy-prod.sh'
```

Then run **deploy-prod** once from the Actions tab via *Run workflow* — manual
dispatch takes the same path as the automatic trigger, so a green manual run means
the automatic one will work.

## Troubleshooting

**Deploy job succeeded but the site looks unchanged.** Check Settings → About. If
the SHA is current, you are looking at a cached page — hard-reload. If it is stale,
`nginx` did not pick up the new `web_dist`; re-run `web-builder` and force-recreate
`nginx`.

**Deploy job failed and the site is up.** That is the rollback working. The job log
ends with the tail of each unhealthy service's output — start there.

**Desktop app never updates.** In order:
1. `curl -i https://communication.rnrtechs.com/downloads/latest.yml` — expect 200,
   `Cache-Control: no-cache`, and a version **higher** than the installed one.
2. Unpack the installed app and check `resources/app-update.yml` names the generic
   URL. An app installed before the GitHub→generic switch carries the old feed and
   will never update; it needs one manual reinstall.
3. Compare the manifest hash against the file actually served:
   `openssl dgst -sha512 -binary BlissWork-windows-x64.exe | openssl base64 -A`.
   A mismatch means the manifest was not regenerated after signing.

**`Cannot fast-forward to origin/Prod-Sid`.** The host has commits `origin/Prod-Sid`
does not. Someone committed on the box. Resolve by hand — the script will not
rewrite history under a live build context.

## Notes for the next deploy

Specific to the change set that added expiring presence, org deletion and chat
pagination. Delete this section once it has shipped.

**Two new migrations apply themselves on boot.** `auth-svc` runs
`run_migrations()` and `messaging-svc` runs `store.Migrate()` at startup, so
`0009_org_deletion.sql` and `0014_message_features.sql` land when the containers
come up — there is no separate migrate step to remember, and no separate step to
forget. Both are idempotent (`IF NOT EXISTS` throughout) and additive: new
columns and tables only, nothing dropped or rewritten, so a rollback to the
previous image leaves them harmless rather than broken.

**The gateway's Redis presence keys are renamed** (`presence:user:` →
`presence:u:`, `presence:org:` → `presence:o:`) because they change type from
SET to ZSET, and `SADD` against a ZSET is a `WRONGTYPE` error rather than a
graceful failure. Two consequences:

- `ws-gateway` and `email-worker` must move together. `email-worker` reads that
  key directly to decide whether an unread message becomes an email; deploying
  it alone would make every recipient look offline and mail out notifications
  for messages people had already read. `scripts/deploy-prod.sh` does a single
  `compose up -d`, so this is already satisfied — but do not hand-restart one of
  the two on its own.
- Presence is empty for the first ~20 seconds after the gateway restarts, then
  rebuilds from client polls and reconnect snapshots. Expected, and the same
  behaviour any gateway restart has always had.

The old keys are abandoned rather than migrated. They carry no TTL (that was the
bug), so clear them once after the deploy has settled:

```bash
sudo docker compose -f docker-compose.prod.yml exec redis \
  redis-cli --scan --pattern 'presence:user:*' | xargs -r redis-cli DEL
sudo docker compose -f docker-compose.prod.yml exec redis \
  redis-cli --scan --pattern 'presence:org:*'  | xargs -r redis-cli DEL
```

**Postgres restarts.** The capacity settings (`max_connections`,
`shared_buffers`, …) are `-c` flags on the postgres container's command, so
applying them recreates the container — a brief outage for every service, not a
reload. Do it in the same window as the rest, not as a follow-up.

**Nothing here requires a desktop release.** The desktop fixes are real but ship
on their own cadence through `release.yml`; the backend deploy does not depend
on them and clients on the current build keep working.
