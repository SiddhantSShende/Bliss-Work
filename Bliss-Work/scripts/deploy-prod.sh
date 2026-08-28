#!/usr/bin/env bash
#
# Deploy BlissWork to production.
#
# This is the deploy runbook as code. `.github/workflows/deploy-prod.yml` is a
# thin caller that SSHes in and runs this — everything that can break production
# lives here, in the repo, reviewable, and runnable by hand when CI is down.
#
#   bash scripts/deploy-prod.sh
#
# Production IS this host: docker-compose.prod.yml builds its images from this
# very working tree, so the checkout and the deployment target are the same
# directory. That has two consequences the script is built around:
#
#   1. It refuses to run on a dirty tree or a non-production branch (see `guard`).
#      A `git reset --hard` here would destroy uncommitted work AND deploy
#      something nobody reviewed. Failing closed is the correct behavior.
#   2. Images are tagged with the deployed commit SHA rather than only `latest`,
#      so the previous release stays in the local image store and rollback is a
#      container restart instead of a five-minute rebuild.
#
# Both `.env` AND `.env.prod` (gitignored, on the host) are passed as
# `--env-file` for compose *interpolation* — ${DOMAIN}, ${IMAGE_TAG}, the
# ${*_DB_PASSWORD}s live in `.env`, but ${LIVEKIT_API_KEY} / ${LIVEKIT_API_SECRET}
# (interpolated directly into livekit's `LIVEKIT_KEYS` in the compose file, not
# just read by a service's own `env_file:` key) exist ONLY in `.env.prod`.
# `.env` alone silently resolves those to empty, and LiveKit authenticates
# nobody — every group call dies with no error at deploy time. Verified
# 2026-08-18 by diffing `compose config` under each source; see
# docs/DEPLOY.md and the `prod-compose-needs-both-env-files` runbook note.
# Later `--env-file` wins on overlapping keys, so `.env.prod` layers on top.
#
# ── Two modes ───────────────────────────────────────────────────────────────
# Everything above describes BUILD MODE, which is still the default and is
# unchanged. Setting REGISTRY switches to PULL MODE, where a build VM has
# already produced and pushed the images and this host only pulls them:
#
#     REGISTRY=registry.internal:5000 NAMESPACE=blisswork \
#     IMAGE_TAG=abc1234 bash scripts/deploy-prod.sh
#
# In pull mode point 2 above still holds — the checkout is fast-forwarded and
# the clean-tree guard still applies — but for a different reason. The tree is
# no longer a build context; it is where compose reads the compose file, the
# nginx and Coraza configs and the Postgres CA bundle from. A dirty tree there
# means the running config has drifted from the images being deployed.
#
# Pull mode requires `docker login` to have been run on this host for REGISTRY.
#
# Env overrides: DEPLOY_ALLOW_DIRTY=1 (skip the guard — never in CI),
# HEALTH_TIMEOUT (seconds, default 420), KEEP_IMAGE_TAGS (default 3),
# REGISTRY + NAMESPACE (enable pull mode), IMAGE_TAG (deploy a specific tag
# rather than whatever HEAD resolves to).
#
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="docker-compose.prod.yml"
LOCK_FILE="/tmp/blisswork-deploy.lock"
STATE_DIR="$REPO_DIR/.deploy"
LAST_GOOD="$STATE_DIR/last-good"

# ── Where images come from ──────────────────────────────────────────────────
# Two modes, chosen by whether REGISTRY is set:
#
#   REGISTRY unset (default)  build here, from this working tree, exactly as
#                             this script has always done.
#   REGISTRY set              pull images a build VM already produced. Nothing
#                             is compiled on this host; the checkout is only a
#                             source of config (the compose file, the nginx and
#                             Coraza configs, the Postgres CA bundle).
#
# The compose file reads ${REGISTRY_PREFIX} with a `task-board` default, so
# leaving REGISTRY unset resolves to the same image names as before.
#
# Pull mode needs `docker login` to have been run on this host for REGISTRY, or
# `compose pull` fails on the first private repository it reaches.
REGISTRY="${REGISTRY:-}"
NAMESPACE="${NAMESPACE:-blisswork}"

if [[ -n "$REGISTRY" ]]; then
    PULL_MODE=1
    REGISTRY_PREFIX="$REGISTRY/$NAMESPACE"
    # The overlay repoints nginx at the prebuilt web image and drops the
    # one-shot that used to fill the web_dist volume.
    COMPOSE_ARGS=(--env-file .env --env-file .env.prod -f "$COMPOSE_FILE" -f docker-compose.registry.yml)
else
    PULL_MODE=0
    REGISTRY_PREFIX="task-board"
    COMPOSE_ARGS=(--env-file .env --env-file .env.prod -f "$COMPOSE_FILE")
fi
export REGISTRY_PREFIX

# Compose SERVICE names we build (or pull) rather than take from upstream.
# Everything else in the compose file is a digest-pinned upstream image.
BUILT_SERVICES=(auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc ws-gateway caddy)

# IMAGE repository names, one per entry above — identical except for caddy,
# whose service is `caddy` but whose image is `caddy-waf`.
#
# caddy USED TO BE EXCLUDED from this bookkeeping because it pinned a literal
# `:2.11` tag. That is safe only while the image never leaves this host: pushed
# to a shared registry, a fixed tag lets every WAF change overwrite the same
# manifest, leaving nothing to roll back to. It is now tagged, pruned and rolled
# back like everything else.
SHA_TAGGED_IMAGES=(auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc ws-gateway caddy-waf)

# Services that declare a healthcheck and must report `healthy` before a deploy
# counts as good. email-worker declares none, so polling it would wait forever on
# a status that never arrives.
#
# caddy IS here now, and it is the most important entry: it is the only service
# whose failure takes the whole site down, and it used to be excluded for lacking
# a healthcheck. A deploy once passed this gate with every service behind the edge
# healthy while the edge itself crash-looped — the gate was measuring the wrong
# eight things.
HEALTH_SERVICES=(auth-svc task-svc notification-svc messaging-svc integrations-svc telemetry-svc ws-gateway nginx caddy)

# The full application scope for `compose up -d` — deliberately EXCLUDES the
# observability stack (otel-collector, prometheus, the 3 exporters, cadvisor,
# alertmanager, tempo, loki, grafana). None of those declare a `profiles:` key,
# so a bare `compose up -d` over the whole file sweeps them into every deploy —
# as of 2026-08-20 that stack is already running on the production host, so an
# unscoped `up -d` would needlessly recreate it (and re-fetch/rebuild it on a
# host that never intended to redeploy monitoring) on every single app deploy.
# `delivery-svc` and `desktop-builder` are already excluded via their own
# `profiles: [routed]` / `profiles: [desktop]`, so they don't need listing here.
CORE_SERVICES=(postgres redis kafka kafka-init livekit coturn auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc ws-gateway graph-gw caddy nginx)

# 180s (the original default) is too tight on this host: `wait_healthy` polls
# each of the 9 HEALTH_SERVICES with its own `sudo docker compose ... ps -q` +
# `docker inspect` call (double --env-file parsing per call), and one full pass
# alone can take well over a minute — verified 2026-08-28, when a real deploy
# with every service actually healthy still tripped the 180s deadline mid-poll
# and triggered a needless rollback. All 9 services were consistently healthy
# within ~4 minutes; 420s leaves real headroom above that.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-420}"
KEEP_IMAGE_TAGS="${KEEP_IMAGE_TAGS:-3}"

# A caller may name the tag to deploy. Jenkins does: it knows which tag it
# actually built and pushed, and that is not necessarily this checkout's HEAD —
# a later config-only commit moves HEAD without producing any images. Captured
# here, before anything else touches IMAGE_TAG. Unset, HEAD wins, as before.
REQUESTED_TAG="${IMAGE_TAG:-}"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Docker may or may not be reachable without sudo depending on whether the
# deploy user is in the `docker` group. Detect once rather than assuming: this
# script runs unattended over SSH, where a sudo password prompt would hang the
# job rather than fail it.
if docker info >/dev/null 2>&1; then
    DOCKER="docker"
    USE_SUDO=0
elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    USE_SUDO=1
else
    printf '\033[1;31m✗ cannot reach the Docker daemon (with or without passwordless sudo)\033[0m\n' >&2
    exit 1
fi

# IMAGE_TAG must reach compose, and `sudo` SANITIZES THE ENVIRONMENT — an
# exported IMAGE_TAG silently does not survive `sudo docker compose`, so compose
# falls back to the IMAGE_TAG in `.env` (which is `latest`).
#
# That is not a cosmetic bug. It breaks ROLLBACK: the rollback path exports the
# previous tag and calls `compose up -d`, compose sees no change from what is
# already running, and reports success having reverted nothing. A deploy that
# genuinely broke production would stay broken while the script announced a
# successful rollback. Forward it explicitly, read at call time so the value is
# whatever the caller most recently set.
#
# REGISTRY_PREFIX rides along for the same reason: the compose file interpolates
# it to decide whether an image name means "built here" or "pull from the
# registry VM", and a sanitized environment would silently fall back to the
# local `task-board` default while the script reported a registry deploy.
compose() {
    if (( USE_SUDO )); then
        sudo env IMAGE_TAG="${IMAGE_TAG:-latest}" \
                 REGISTRY_PREFIX="$REGISTRY_PREFIX" \
                 docker compose "${COMPOSE_ARGS[@]}" "$@"
    else
        docker compose "${COMPOSE_ARGS[@]}" "$@"
    fi
}

# ── Serialize ───────────────────────────────────────────────────────────────
# Two overlapping deploys would interleave `git merge` with `docker build` and
# leave the tree describing one commit while the containers run another.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy is already running (lock: $LOCK_FILE)"

cd "$REPO_DIR"

# ── Guard ───────────────────────────────────────────────────────────────────
guard() {
    local branch dirty count
    branch="$(git rev-parse --abbrev-ref HEAD)"
    dirty="$(git status --porcelain)"

    if [[ "${DEPLOY_ALLOW_DIRTY:-0}" == "1" ]]; then
        warn "DEPLOY_ALLOW_DIRTY=1 — branch/clean-tree guard skipped."
        warn "Deploying whatever is in the working tree. Never set this in CI."
        return
    fi

    [[ "$branch" == "Prod-Sid" ]] || die \
"Refusing to deploy: on branch '$branch', expected 'Prod-Sid'.

This checkout is production's build context. Switch it to Prod-Sid, or set
DEPLOY_ALLOW_DIRTY=1 if you are deliberately deploying a branch by hand."

    if [[ -n "$dirty" ]]; then
        count="$(printf '%s\n' "$dirty" | wc -l)"
        printf '%s\n' "$dirty" | head -20 >&2
        (( count > 20 )) && warn "… and $((count - 20)) more"
        die \
"Refusing to deploy: the working tree has $count uncommitted change(s) (above).

Deploying would either discard this work or ship unreviewed code. Commit,
stash, or merge it first."
    fi
}

# ── Health gate ─────────────────────────────────────────────────────────────
# Compose's own healthchecks are the source of truth; we only wait on them.
wait_healthy() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT))
    local svc cid status
    local -a pending

    while :; do
        pending=()
        for svc in "${HEALTH_SERVICES[@]}"; do
            cid="$(compose ps -q "$svc" 2>/dev/null || true)"
            if [[ -z "$cid" ]]; then
                pending+=("$svc(missing)")
                continue
            fi
            status="$($DOCKER inspect \
                --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
                "$cid" 2>/dev/null || echo unknown)"
            [[ "$status" == "healthy" ]] || pending+=("$svc($status)")
        done

        (( ${#pending[@]} == 0 )) && return 0

        if (( SECONDS >= deadline )); then
            warn "not healthy after ${HEALTH_TIMEOUT}s: ${pending[*]}"
            for svc in "${HEALTH_SERVICES[@]}"; do
                printf -- '--- %s ---\n' "$svc" >&2
                compose logs --tail 40 "$svc" >&2 2>&1 || true
            done
            return 1
        fi
        sleep 5
    done
}

smoke_test() {
    local domain
    # DOMAIN comes from .env — the same file compose interpolates from.
    domain="$(grep -E '^DOMAIN=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    if [[ -z "$domain" ]]; then
        warn "DOMAIN not set in .env — skipping the HTTPS smoke test."
        return 0
    fi
    log "Smoke test: https://$domain/"
    curl -fsS --max-time 20 "https://$domain/" -o /dev/null

    # A status code cannot tell you the app WORKS. Two deploys have now gone
    # green while it was dead — once because a missing VITE_* var made the
    # bundle throw on boot, once because index.html named a bundle that no
    # longer existed. Both served 200 for every request.
    #
    # smoke-web.mjs loads the app in a real browser and fails on an uncaught
    # error or an empty #root. It degrades to asset checks where no browser is
    # available, so a CI image without Chromium still deploys — and says so.
    log "Smoke test: does the app boot?"
    node "$REPO_DIR/scripts/smoke-web.mjs" "https://$domain"
}

# Rebuild the SPA bundle into the web_dist volume, then recreate nginx so it
# serves the new files. nginx declares `depends_on: web-builder:
# service_completed_successfully`, so it must be recreated explicitly after the
# one-shot run rather than picking the change up on its own.
deploy_web_bundle() {
    if (( PULL_MODE )); then
        # The bundle is baked into the nginx image by apps/web/Dockerfile, and
        # the `compose up -d` above already recreated nginx because its image
        # tag changed. There is nothing to build and no volume to fill.
        log "Web bundle ships inside the nginx image — nothing to build"
        return
    fi

    log "Building web bundle (web-builder one-shot)"
    compose run --rm --no-deps web-builder
    log "Recreating nginx"
    compose up -d --force-recreate nginx
}

# ── Rollback ────────────────────────────────────────────────────────────────
rollback() {
    trap - ERR                      # a failure inside rollback must not recurse
    local prev_sha="$1" prev_tag="$2"
    warn "Deploy failed — rolling back to $prev_sha (images: ${prev_tag:-unknown})"

    git reset --hard "$prev_sha"

    if [[ -n "$prev_tag" ]] && $DOCKER image inspect "$REGISTRY_PREFIX/auth-svc:$prev_tag" >/dev/null 2>&1; then
        # The previous image set is still in the local store, so this is a
        # container restart, not a rebuild.
        export IMAGE_TAG="$prev_tag"
        compose up -d --remove-orphans "${CORE_SERVICES[@]}"
    elif (( PULL_MODE )); then
        # Pull mode makes rollback strictly better than it was: the previous tag
        # lives in the registry, so it is recoverable even after the local store
        # has been pruned. Rebuilding from source was the only option before.
        warn "No local image set tagged '${prev_tag:-unknown}' — pulling it from $REGISTRY."
        export IMAGE_TAG="${prev_tag:-latest}"
        compose pull "${BUILT_SERVICES[@]}" nginx
        compose up -d --remove-orphans "${CORE_SERVICES[@]}"
    else
        warn "No local image set tagged '${prev_tag:-unknown}' — rebuilding from $prev_sha."
        export IMAGE_TAG="${prev_tag:-latest}"
        compose up -d --build --remove-orphans "${CORE_SERVICES[@]}"
    fi
    deploy_web_bundle

    warn "Rollback complete: production is back on $prev_sha."
    exit 1
}

# Keep the N most recent SHA tags per service so per-deploy tags can't fill the
# disk. `latest` is never a candidate — it always points at the live set.
prune_old_images() {
    local img tag
    for img in "${SHA_TAGGED_IMAGES[@]}"; do
        $DOCKER images "$REGISTRY_PREFIX/$img" --format '{{.Tag}}|{{.CreatedAt}}' 2>/dev/null \
            | grep -v '^latest|' \
            | grep -v '^<none>|' \
            | sort -t'|' -k2 -r \
            | tail -n "+$((KEEP_IMAGE_TAGS + 1))" \
            | cut -d'|' -f1 \
            | while read -r tag; do
                [[ -n "$tag" && "$tag" != "$IMAGE_TAG" ]] || continue
                $DOCKER rmi "$REGISTRY_PREFIX/$img:$tag" >/dev/null 2>&1 || true
              done
    done
}

# ── main ────────────────────────────────────────────────────────────────────
guard

mkdir -p "$STATE_DIR"
PREV_SHA="$(git rev-parse HEAD)"
PREV_TAG="$(cat "$LAST_GOOD" 2>/dev/null || true)"
log "Current: $PREV_SHA (images: ${PREV_TAG:-unknown})"

log "Fetching origin"
git fetch --prune origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# --ff-only: if the host has diverged from origin, stop rather than rewriting
# history under a directory that IS the build context.
if ! git merge --ff-only "origin/$BRANCH"; then
    [[ "${DEPLOY_ALLOW_DIRTY:-0}" == "1" ]] \
        || die "Cannot fast-forward to origin/$BRANCH — the host has diverged. Resolve by hand."
    warn "Fast-forward skipped (DEPLOY_ALLOW_DIRTY=1); deploying the current tree."
fi

NEW_SHA="$(git rev-parse HEAD)"
IMAGE_TAG="${REQUESTED_TAG:-$(git rev-parse --short HEAD)}"
export IMAGE_TAG   # a shell env var beats the IMAGE_TAG in .env for interpolation
if [[ -n "$REQUESTED_TAG" ]]; then
    log "Deploying $NEW_SHA with caller-supplied image tag '$IMAGE_TAG'"
else
    log "Deploying $NEW_SHA as image tag '$IMAGE_TAG'"
fi

trap 'rollback "$PREV_SHA" "$PREV_TAG"' ERR

if (( PULL_MODE )); then
    log "Pulling images from $REGISTRY_PREFIX (tag $IMAGE_TAG)"
    # Only the images this project publishes. Everything else in the compose
    # file is a digest-pinned upstream image that is already on disk, and
    # pulling the whole file would re-check two dozen of them on every deploy.
    # nginx is in the list because in pull mode it IS the web bundle image.
    compose pull "${BUILT_SERVICES[@]}" nginx
else
    log "Building service images"
    compose build "${BUILT_SERVICES[@]}"

    # Keep `:latest` pointing at the live set so a bare `docker compose up -d`
    # (with no IMAGE_TAG exported) still starts what is actually deployed. In
    # pull mode the registry publishes its own `:latest`, so there is nothing
    # to alias locally.
    for img in "${SHA_TAGGED_IMAGES[@]}"; do
        $DOCKER tag "$REGISTRY_PREFIX/$img:$IMAGE_TAG" "$REGISTRY_PREFIX/$img:latest"
    done
fi

log "Rolling services (each service runs its migrations at boot)"
compose up -d --remove-orphans "${CORE_SERVICES[@]}"

deploy_web_bundle

log "Waiting for healthchecks (timeout ${HEALTH_TIMEOUT}s)"
wait_healthy

smoke_test

trap - ERR

echo "$IMAGE_TAG" > "$LAST_GOOD"
log "Pruning old image tags (keeping $KEEP_IMAGE_TAGS per service)"
prune_old_images

log "Deployed $NEW_SHA successfully."
