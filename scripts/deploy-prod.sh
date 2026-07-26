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
#   1. It refuses to run on a dirty tree or a non-main branch (see `guard`).
#      A `git reset --hard` here would destroy uncommitted work AND deploy
#      something nobody reviewed. Failing closed is the correct behavior.
#   2. Images are tagged with the deployed commit SHA rather than only `latest`,
#      so the previous release stays in the local image store and rollback is a
#      container restart instead of a five-minute rebuild.
#
# No `--env-file` is passed to compose, deliberately. `.env` (gitignored, on the
# host) supplies compose *interpolation* — ${DOMAIN}, ${IMAGE_TAG}, the
# ${*_DB_PASSWORD}s — while each service reads `.env.prod` through its own
# `env_file:` key. Passing `--env-file .env.prod` would silently swap the
# interpolation source and is not the same thing.
#
# Env overrides: DEPLOY_ALLOW_DIRTY=1 (skip the guard — never in CI),
# HEALTH_TIMEOUT (seconds, default 180), KEEP_IMAGE_TAGS (default 3).
#
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="docker-compose.prod.yml"
LOCK_FILE="/tmp/blisswork-deploy.lock"
STATE_DIR="$REPO_DIR/.deploy"
LAST_GOOD="$STATE_DIR/last-good"

# Images we build from source. Everything else in the compose file is a
# digest-pinned upstream image.
#
# caddy is built too, but it pins its own `task-board/caddy-waf:2.11` tag rather
# than ${IMAGE_TAG}, so it takes no part in the SHA-tag/prune/rollback bookkeeping.
SHA_TAGGED_SERVICES=(auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc ws-gateway)
BUILT_SERVICES=("${SHA_TAGGED_SERVICES[@]}" caddy)

# Services that declare a healthcheck and must report `healthy` before a deploy
# counts as good. caddy and email-worker declare none, so polling them would
# wait forever on a status that never arrives.
HEALTH_SERVICES=(auth-svc task-svc notification-svc messaging-svc integrations-svc ws-gateway nginx)

HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
KEEP_IMAGE_TAGS="${KEEP_IMAGE_TAGS:-3}"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

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

    [[ "$branch" == "main" ]] || die \
"Refusing to deploy: on branch '$branch', expected 'main'.

This checkout is production's build context. Switch it to main, or set
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
            status="$(docker inspect \
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
}

# Rebuild the SPA bundle into the web_dist volume, then recreate nginx so it
# serves the new files. nginx declares `depends_on: web-builder:
# service_completed_successfully`, so it must be recreated explicitly after the
# one-shot run rather than picking the change up on its own.
deploy_web_bundle() {
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

    if [[ -n "$prev_tag" ]] && docker image inspect "task-board/auth-svc:$prev_tag" >/dev/null 2>&1; then
        # The previous image set is still in the local store, so this is a
        # container restart, not a rebuild.
        export IMAGE_TAG="$prev_tag"
        compose up -d --remove-orphans
    else
        warn "No local image set tagged '${prev_tag:-unknown}' — rebuilding from $prev_sha."
        export IMAGE_TAG="${prev_tag:-latest}"
        compose up -d --build --remove-orphans
    fi
    deploy_web_bundle

    warn "Rollback complete: production is back on $prev_sha."
    exit 1
}

# Keep the N most recent SHA tags per service so per-deploy tags can't fill the
# disk. `latest` is never a candidate — it always points at the live set.
prune_old_images() {
    local svc tag
    for svc in "${SHA_TAGGED_SERVICES[@]}"; do
        docker images "task-board/$svc" --format '{{.Tag}}|{{.CreatedAt}}' 2>/dev/null \
            | grep -v '^latest|' \
            | grep -v '^<none>|' \
            | sort -t'|' -k2 -r \
            | tail -n "+$((KEEP_IMAGE_TAGS + 1))" \
            | cut -d'|' -f1 \
            | while read -r tag; do
                [[ -n "$tag" && "$tag" != "$IMAGE_TAG" ]] || continue
                docker rmi "task-board/$svc:$tag" >/dev/null 2>&1 || true
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
IMAGE_TAG="$(git rev-parse --short HEAD)"
export IMAGE_TAG   # a shell env var beats the IMAGE_TAG in .env for interpolation
log "Deploying $NEW_SHA as image tag '$IMAGE_TAG'"

trap 'rollback "$PREV_SHA" "$PREV_TAG"' ERR

log "Building service images"
compose build "${BUILT_SERVICES[@]}"

# Keep `:latest` pointing at the live set so a bare `docker compose up -d` (with
# no IMAGE_TAG exported) still starts what is actually deployed.
for svc in "${SHA_TAGGED_SERVICES[@]}"; do
    docker tag "task-board/$svc:$IMAGE_TAG" "task-board/$svc:latest"
done

log "Rolling services (each service runs its migrations at boot)"
compose up -d --remove-orphans

deploy_web_bundle

log "Waiting for healthchecks (timeout ${HEALTH_TIMEOUT}s)"
wait_healthy

smoke_test

trap - ERR

echo "$IMAGE_TAG" > "$LAST_GOOD"
log "Pruning old image tags (keeping $KEEP_IMAGE_TAGS per service)"
prune_old_images

log "Deployed $NEW_SHA successfully."
