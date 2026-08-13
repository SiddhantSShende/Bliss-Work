# Deploying BlissWork

How code gets from a commit to production and to users' desktops.

For connecting external platforms see [`INTEGRATIONS-SETUP.md`](INTEGRATIONS-SETUP.md);
for backups, key rotation and the WAF see [`OPERATIONS.md`](OPERATIONS.md).

## The pipeline

```
                 push / merge to main
                          │
                          ▼
                  ┌───────────────┐
                  │  CI (ci.yml)  │   lint · typecheck · unit · integration
                  │               │   go -race · trivy · codeql · e2e
                  └───────┬───────┘
                          │ success only
              ┌───────────┴───────────┐
              ▼                       ▼
   ┌────────────────────┐   ┌──────────────────────┐
   │  deploy-prod.yml   │   │    release.yml       │
   │  ssh → VPS         │   │  build win/mac/linux │
   │  deploy-prod.sh    │   │  sign · manifest     │
   └─────────┬──────────┘   └──────────┬───────────┘
             ▼                         ▼
   web app + 7 services       rsync → /downloads/
   live at communication      ↳ installers + latest*.yml
   .rnrtechs.com             ↳ electron-updater feed
                                        │
                                        ▼
                          installed apps self-update on next launch
```

Nothing deploys from a feature branch or a pull request. `workflow_run` never
fires for `pull_request` events, and both deploy workflows are gated on
`conclusion == 'success'`, so a red CI run leaves them **skipped**.

## Web app + backend

`.github/workflows/deploy-prod.yml` carries the SSH key and nothing else. All the
logic is in **`scripts/deploy-prod.sh`**, in the repo, so a deploy is reviewable
in a PR and reproducible by hand when GitHub is down.

What the script does, in order:

1. **Guards.** Refuses to run unless the checkout is on `main` with a clean tree.
2. **Fast-forwards** to `origin/main` (never `reset --hard`, never a merge commit).
3. **Tags images with the commit SHA** — `IMAGE_TAG=$(git rev-parse --short HEAD)`,
   exported so it wins over the value in `.env`. The previous image set stays in
   the local store, which is what makes rollback fast.
4. **Builds and rolls** the seven services plus caddy. Each service runs its own
   migrations at boot, so there is no separate migration step.
5. **Rebuilds the web bundle** via the one-shot `web-builder`, then force-recreates
   `nginx`. `index.html` is served `no-cache`, so browsers pick the new bundle up
   on their next load — that is the web app's "auto-update".
6. **Waits for healthchecks** on all seven health-declaring services, then makes
   one HTTPS request to the site.
7. **Rolls back automatically** if any of that fails: back to the previous commit
   and the previous image tag, then exits non-zero so the job goes red.
8. **Prunes** all but the 3 most recent image tags per service.

### The clean-tree guard, and why it exists

`/home/ubuntu/BlissWork/Bliss-Work` is simultaneously your working copy **and**
production's docker build context. There is no separate deploy checkout, because
a second clone would spawn a second compose project with its own volumes.

So a deploy that blindly synced to `origin/main` would either destroy uncommitted
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

# Deploy the current (possibly dirty, possibly non-main) tree — you own this
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

**Versioning is automatic.** Every green build of `main` publishes
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

**`Cannot fast-forward to origin/main`.** The host has commits `origin/main` does
not. Someone committed on the box. Resolve by hand — the script will not rewrite
history under a live build context.
