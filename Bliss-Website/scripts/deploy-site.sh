#!/usr/bin/env bash
#
# Deploy the BlissWork marketing site.
#
# This is the deploy runbook as code. `.github/workflows/deploy-site.yml` is a
# thin caller that SSHes in and runs this — mirroring the convention in the
# Bliss-Work repo (scripts/deploy-prod.sh), so a deploy is reviewable in a PR and
# reproducible by hand when GitHub is down.
#
#   bash scripts/deploy-site.sh
#
# ── How this site is served ──────────────────────────────────────────────────
# There is no build step on the server side of Caddy: `dist/` is bind-mounted
# read-only into the Caddy container at /srv/blisswork
# (Bliss-Work/docker-compose.prod.yml) and served by `file_server`. Writing new
# files into dist/ IS the deploy — no container restart, no image rebuild.
#
# Two properties that mount makes load-bearing:
#
#   1. `dist/` must keep its inode. A bind mount follows the directory that
#      existed at container start; `rm -rf dist` would leave Caddy serving a
#      deleted inode forever, and the site would freeze at the last build with no
#      error anywhere. So we build into a staging directory and rsync INTO dist,
#      never replacing dist itself.
#   2. That also makes the swap near-atomic. A plain `vite build` empties dist/
#      first and then writes ~2 s of files into it, during which visitors get 404s
#      on a live production site. rsync --delete applies the diff in place.
#
# A failed build therefore leaves the currently-deployed site completely
# untouched, which is the main reason for the staging directory.
#
# ── Installers are NOT here ──────────────────────────────────────────────────
# Desktop installers live in /home/ubuntu/BlissWork/downloads, deployed
# separately by Bliss-Work's release.yml, and are served at /downloads/* by nginx
# via an explicit Caddy route. They used to sit in dist/downloads, where every
# run of this script would have deleted them. Do not move them back.
#
# Env overrides: DEPLOY_ALLOW_DIRTY=1 (skip the clean-tree guard — never in CI),
# DEPLOY_REF (default origin/Prod-Sid — the production branch; see
# Bliss-Work/.github/workflows/release.yml for why it isn't main).
#
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/blisswork-site-deploy.lock"
STAGING_DIR="$REPO_DIR/.dist-staging"
DIST_DIR="$REPO_DIR/dist"
DEPLOY_REF="${DEPLOY_REF:-origin/Prod-Sid}"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"

# Serialize. Two concurrent rsyncs into the same live directory could interleave
# a new index.html with the previous build's fingerprinted assets.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another site deploy is in progress ($LOCK_FILE)"

# ── Guard ────────────────────────────────────────────────────────────────────
# The checkout IS the deploy source, so `git reset --hard` below would silently
# destroy uncommitted work on the server. Fail closed instead.
if [ -z "${DEPLOY_ALLOW_DIRTY:-}" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short
    die "working tree is dirty — commit, stash or revert on the server first.
    Override with DEPLOY_ALLOW_DIRTY=1 only if you are certain these changes are disposable."
  fi
fi

PREV_SHA="$(git rev-parse --short HEAD)"

log "Fetching $DEPLOY_REF"
git fetch --prune origin
git reset --hard "$DEPLOY_REF"
NEW_SHA="$(git rev-parse --short HEAD)"
echo "  $PREV_SHA → $NEW_SHA"

log "Installing dependencies"
# `npm ci` not `npm install`: reproducible from the lockfile, and it refuses to
# silently drift package.json.
npm ci

log "Typechecking"
# `npm run build` is `tsc -b && vite build`; we can't pass --outDir through it,
# so the two halves run separately. Keep tsc — it is the only gate that stops a
# type error reaching production, and vite alone would happily build past one.
npx tsc -b

log "Building into staging"
rm -rf "$STAGING_DIR"
# --emptyOutDir is required because the target sits outside the default dist/,
# which vite refuses to clear unprompted.
npx vite build --outDir "$STAGING_DIR" --emptyOutDir

[ -f "$STAGING_DIR/index.html" ] || die "build produced no index.html — refusing to deploy"

log "Publishing to dist/"
mkdir -p "$DIST_DIR"
# Trailing slashes matter: sync CONTENTS into dist, preserving dist's own inode
# so the Caddy bind mount keeps working. --delete removes assets from prior
# builds (their filenames are content-hashed, so they accumulate forever
# otherwise) — safe now that installers no longer live under dist/.
rsync -a --delete "$STAGING_DIR/" "$DIST_DIR/"
rm -rf "$STAGING_DIR"

log "Deployed $NEW_SHA"
# Not `git reset --hard && deploy`: the script re-fetches and resets to
# $DEPLOY_REF, which would immediately undo the reset and redeploy Prod-Sid.
echo "  Rollback:  DEPLOY_REF=$PREV_SHA bash scripts/deploy-site.sh"
