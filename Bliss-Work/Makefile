# Task-Board — dev + prod orchestration.
# On Windows run via Git Bash, or use the npm-script equivalents (npm run up/down/...).
#
# Layout of this host (the VPS runs BOTH stacks on one Docker daemon):
#   dev  = docker-compose.yml            project task-board       env from .env
#   prod = docker-compose.prod.yml       project task-board-prod  env from .env AND .env.prod
#
# Conventions:
#   service=<name>   scopes any dev-*/prod-* target to one service (empty = all)
#   env=prod         switches the shared utility targets (exec/clean) to prod
#   Destructive prod targets ask "Are you sure? [y/N]" and abort on anything
#   but "y" — including non-interactive runs, where read gets EOF.
SHELL := bash
.DEFAULT_GOAL := help
# Needed so the production-deploy macros below (DEPLOY_LIB, a `define` block of
# bash functions shared by prod-guard/prod-fetch/prod-deploy/etc.) run as ONE
# continuous shell script — without it, each NEWLINE that a `define` macro
# expands to starts a brand-new shell, so a function defined on one line is
# already gone by the next (verified: "greet: command not found" is exactly
# what that looks like). Audited safe for every OTHER existing recipe in this
# file: each already either uses backslash-continuation (already one shell) or
# is a sequence of independent, self-contained commands where one-shell-vs.-
# separate-shells makes no observable difference (confirmed by diffing `make
# -n` output for prod-down/prod-restart/clean/help before and after: byte
# identical).
.ONESHELL:

# ── Variables ────────────────────────────────────────────────────────────────
# This user isn't in the docker group on the VPS, so fall back to passwordless
# sudo when the daemon isn't reachable directly (dev laptops keep plain docker).
SUDO := $(shell docker info >/dev/null 2>&1 || echo sudo -n)

# Prod images are $(REGISTRY_PREFIX)/<svc>:$(IMAGE_TAG). Default to the last
# DEPLOYED tag (.deploy/last-good): the running containers were created from
# the pinned SHA tag, while .env.prod says `latest` — interpolating `latest`
# would make every `up`/`restart` want to recreate the whole stack.
# ':=' (not '?=') so this is computed exactly ONCE: a '?=' would let a
# pre-set environment variable (e.g. from sourcing .env.prod, which sets
# IMAGE_TAG=latest) silently win, and would re-run `cat` on every expansion,
# letting prod-up's --dry-run preview and its post-confirm `up` see different
# values if .deploy/last-good changes in between. An explicit
# `make ... IMAGE_TAG=x` on the command line still always wins over this.
# Left EMPTY (not defaulted to "latest") when .deploy/last-good is missing —
# it's git-ignored, so a fresh checkout hits this — so PROD_COMPOSE below
# fails loudly instead of silently targeting unmanaged :latest images.
IMAGE_TAG := $(shell cat .deploy/last-good 2>/dev/null)

# ── Registry / pull mode (migrated from scripts/deploy-prod.sh) ─────────────
# REGISTRY unset (default): every prod-* target, prod-deploy included, builds
# images on this host and tags them $(REGISTRY_PREFIX)/<svc>:$(IMAGE_TAG) —
# unchanged from before. REGISTRY set: a build VM (Jenkins) has already built
# and pushed images there under NAMESPACE, and prod-deploy PULLS instead of
# building (see "Production deployment" below, and docker-compose.registry.yml
# for what the overlay changes). REGISTRY_PREFIX now computes the same way
# deploy-prod.sh did, so it's pull-mode-aware everywhere, not just in
# prod-deploy. A literal `make ... REGISTRY_PREFIX=x` on the command line
# still always wins — Make command-line values can't be overridden by a plain
# `:=` in the file, so this stays backward compatible with any caller that set
# REGISTRY_PREFIX directly instead of via REGISTRY+NAMESPACE.
REGISTRY  ?=
NAMESPACE ?= blisswork
REGISTRY_PREFIX := $(if $(REGISTRY),$(REGISTRY)/$(NAMESPACE),task-board)

service ?=
env ?= dev
ifneq ($(filter-out dev prod,$(env)),)
$(error env must be 'dev' or 'prod' (got '$(env)'))
endif

DEV_COMPOSE  = $(SUDO) docker compose -f docker-compose.yml --env-file .env
# BOTH env files, in this order — .env.prod wins. .env alone leaves
# LIVEKIT_API_KEY/SECRET blank and every group call dies.
# $(or ...) only fires when PROD_COMPOSE is actually expanded (i.e. a prod-*
# target runs), so a missing IMAGE_TAG doesn't break `make help` or dev
# targets on a laptop that has no .deploy/ directory at all.
PROD_COMPOSE = $(SUDO) env IMAGE_TAG=$(or $(IMAGE_TAG),$(error IMAGE_TAG not set - no .deploy/last-good on this checkout and none passed; run with IMAGE_TAG=<sha> explicitly)) REGISTRY_PREFIX=$(REGISTRY_PREFIX)$(if $(DESKTOP_VERSION), DESKTOP_VERSION=$(DESKTOP_VERSION)) \
	docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml
COMPOSE = $(if $(filter prod,$(env)),$(PROD_COMPOSE),$(DEV_COMPOSE))

# ── Confirmation helper (destructive prod targets) ───────────────────────────
define confirm
	@printf '\n⚠  This is PRODUCTION — about to %s.\nAre you sure? [y/N] ' "$(1)"; \
	read -r ans; \
	if [ "$$ans" != "y" ]; then echo "Aborted — nothing was done."; exit 1; fi
endef

.PHONY: help env keys up wait seed demo logs ps down reset test check-migrations \
	dev-up dev-down dev-restart dev-logs dev-ps dev-build dev-reset-db \
	prod-up prod-down prod-restart prod-logs prod-ps prod-build \
	prod-deploy prod-guard prod-fetch prod-deploy-images prod-deploy-core \
	prod-deploy-web prod-health prod-smoke prod-rollback prod-prune \
	dev prod web-dev web-build web-release desktop-dev desktop-build desktop-release \
	exec clean prune

help:
	@echo "Task-Board targets   (service=<name> scopes to one service; empty = all)"
	@echo ""
	@echo "Dev stack (docker-compose.yml + .env — no confirmation):"
	@echo "  make dev          - dev-up + wait until healthy + status"
	@echo "  make dev-up       - start the dev stack (or one service)"
	@echo "  make dev-down     - stop it"
	@echo "  make dev-restart  - restart it"
	@echo "  make dev-logs     - tail logs"
	@echo "  make dev-ps       - container status"
	@echo "  make dev-build    - build images"
	@echo "  make dev-reset-db - delete ALL dev volumes (fresh DB; whole stack only,"
	@echo "                      service= is rejected; also wipes dev media blobs)"
	@echo ""
	@echo "Prod stack (docker-compose.prod.yml + .env + .env.prod — gated where destructive):"
	@echo "  make prod         - prod-up (start whatever IMAGE_TAG is already deployed,"
	@echo "                      from .deploy/last-good) + status. Does NOT pull new code"
	@echo "                      or images — for that, see 'make prod-deploy' below."
	@echo "  make prod-up      - start; scoped to service=X runs directly (--no-deps),"
	@echo "                      except web-builder/desktop-builder which CONFIRM first"
	@echo "                      (one-shots that publish to the live site/downloads);"
	@echo "                      the no-service form shows a dry-run, then asks"
	@echo "  make prod-down    - CONFIRM, then down       (no service = whole site!)"
	@echo "  make prod-restart - CONFIRM, then restart (no service = every RUNNING"
	@echo "                      service; stopped one-shots are left alone)"
	@echo "  make prod-logs    - tail logs (read-only, direct)"
	@echo "  make prod-ps      - container status"
	@echo "  make prod-build   - build images, tagged IMAGE_TAG=<git HEAD>[-dirty]"
	@echo "                      unless overridden with IMAGE_TAG=x on the command"
	@echo "                      line; refuses to overwrite the deployed/rollback tag"
	@echo ""
	@echo "Production DEPLOYMENT (the single source of truth — no scripts/deploy-prod.sh"
	@echo "any more; this IS the deploy runbook, reviewable and runnable by hand):"
	@echo "  make prod-deploy  - full deploy: guard, lock, git fetch+ff-only, build OR"
	@echo "                      pull images (REGISTRY=host set = pull), roll core"
	@echo "                      services, rebuild+publish the web bundle, wait for"
	@echo "                      health, smoke test, save .deploy/last-good, prune old"
	@echo "                      image tags — auto rollback to the previous known-good"
	@echo "                      version on ANY failure. Runs unattended (CI/Jenkins),"
	@echo "                      so unlike other prod-* targets it does NOT prompt."
	@echo "                      On branch Prod-Sid with a clean tree only, unless:"
	@echo "                        DEPLOY_ALLOW_DIRTY=1   skip the branch/clean-tree guard"
	@echo "                        IMAGE_TAG=<tag>        deploy this exact tag, not HEAD"
	@echo "                        REGISTRY=<host>        pull-mode; also needs NAMESPACE"
	@echo "                        HEALTH_TIMEOUT=<secs>  default 420"
	@echo "                        KEEP_IMAGE_TAGS=<n>    default 3, per-service retention"
	@echo "  make prod-guard   - just the branch + clean-tree check (no changes made)"
	@echo "  make prod-fetch   - just fetch + fast-forward-only merge to origin/Prod-Sid"
	@echo "  make prod-health  - just poll HEALTH_TIMEOUT for every core service healthy"
	@echo "  make prod-smoke   - just the HTTPS + real-browser smoke test"
	@echo "  make prod-rollback- redeploy .deploy/last-good's image tag right now (does"
	@echo "                      NOT touch git state — only prod-deploy's automatic,"
	@echo "                      failure-triggered rollback resets the checkout too)"
	@echo "  make prod-prune   - delete old SHA-tagged images beyond KEEP_IMAGE_TAGS"
	@echo ""
	@echo "Client apps (desktop is Electron; mobile = the responsive web app, no native workspace):"
	@echo "  make web-dev          - Vite dev server for the web app"
	@echo "  make web-build        - production build of the web app (local only,"
	@echo "                          does NOT publish — see web-release for that)"
	@echo "  make web-release      - CONFIRM, then rebuild the web bundle from the"
	@echo "                          working tree, PUBLISH it, and recreate nginx so"
	@echo "                          it's actually served"
	@echo "  make desktop-dev      - run the desktop app against the dev stack"
	@echo "  make desktop-build    - package installers locally (electron-builder)"
	@echo "  make desktop-release  - CONFIRM, then build Linux+Windows installers in the"
	@echo "                          builder container and PUBLISH them to the live downloads"
	@echo "                          (DESKTOP_VERSION=x.y.z overrides the auto patch bump)"
	@echo ""
	@echo "Utilities:"
	@echo "  make exec service=X [env=prod]   - shell inside a running container"
	@echo "  make clean [service=X] [env=prod] - remove stopped containers of the"
	@echo "                                       chosen stack, or just one service"
	@echo "  make prune  - prune dangling images + build cache on the shared Docker"
	@echo "                daemon (never -a: rollback tags must survive); affects"
	@echo "                BOTH stacks — service=/env= have no effect here"
	@echo ""
	@echo "Legacy dev shortcuts: env keys up wait seed demo logs ps down reset test"

# ── Dev targets (no confirmation — safe zone) ────────────────────────────────
dev-up: env keys
	$(DEV_COMPOSE) up -d $(service)

# Scoped stop uses `stop`+`rm -f`, NOT `down <service>`: `down` always also
# tries to remove the shared project network, which fails (network still in
# use by other running services) and makes the scoped call exit non-zero
# even though the target container stopped correctly. `down` with no
# service is still used for the full teardown, where removing the network
# is exactly what's wanted.
dev-down:
ifeq ($(service),)
	$(DEV_COMPOSE) down
else
	$(DEV_COMPOSE) stop $(service)
	$(DEV_COMPOSE) rm -f $(service)
endif

dev-restart:
	$(DEV_COMPOSE) restart $(service)

dev-logs:
	$(DEV_COMPOSE) logs -f --tail=200 $(service)

dev-ps:
	$(DEV_COMPOSE) ps $(service)

dev-build:
	$(DEV_COMPOSE) build $(service)

dev-reset-db:
	@test -z "$(service)" || { echo "dev-reset-db always wipes ALL dev volumes (compose can't scope named-volume deletion to one service) — run without service="; exit 1; }
	$(DEV_COMPOSE) down -v
	@echo "Dev volumes deleted — next dev-up starts with a fresh database."

# ── Prod targets (danger zone) ───────────────────────────────────────────────
# A bare `up` on the prod file re-runs web-builder (rebuilds the live web
# bundle) and sweeps the whole observability stack, so the no-service form
# previews with --dry-run and asks first. A scoped up uses --no-deps so
# starting one service can't recreate its dependency chain.
prod-up:
ifeq ($(service),)
	$(PROD_COMPOSE) up -d --no-build --dry-run
	$(call confirm,bring up / recreate the ENTIRE prod stack as previewed above)
	$(PROD_COMPOSE) up -d --no-build
else ifneq ($(filter web-builder desktop-builder,$(service)),)
	$(call confirm,run the one-shot $(service) - this REBUILDS from the working tree and PUBLISHES the result to the live site/download feed)
	$(PROD_COMPOSE) up -d --no-build --no-deps $(service)
else
	$(PROD_COMPOSE) up -d --no-build --no-deps $(service)
endif

prod-down:
	$(call confirm,take DOWN $(if $(service),service $(service),the WHOLE site - every prod container))
ifeq ($(service),)
	$(PROD_COMPOSE) down
else
	$(PROD_COMPOSE) stop $(service)
	$(PROD_COMPOSE) rm -f $(service)
endif

# Unscoped restart is limited to currently-RUNNING services: `compose restart`
# also (re)starts exited containers, and the prod file's one-shots
# (web-builder, kafka-init) sit Exited(0) between deploys — an unscoped
# restart would silently re-run web-builder and republish the live web
# bundle from the working tree as a side effect of what the operator
# confirmed as "restart". If nothing is running at all (e.g. right after a
# prod-down), skip instead of falling through to a bare `restart` with no
# service args — compose then targets EVERY service, one-shots included.
prod-restart:
	$(call confirm,restart $(if $(service),service $(service),every currently-RUNNING prod service (stopped one-shots like web-builder/kafka-init are left alone)))
	@target="$(service)"; \
	[ -n "$$target" ] || target="$$($(PROD_COMPOSE) ps --services --status running)"; \
	if [ -z "$$target" ]; then echo "Nothing running — skipping."; exit 0; fi; \
	echo "+ $(PROD_COMPOSE) restart $$target"; \
	$(PROD_COMPOSE) restart $$target

prod-logs:
	$(PROD_COMPOSE) logs -f --tail=200 $(service)

prod-ps:
	$(PROD_COMPOSE) ps $(service)

# Only auto-derive the build tag from git HEAD when IMAGE_TAG still holds its
# file-origin default (.deploy/last-good) — an explicit
# `IMAGE_TAG=x make prod-build` (command-line origin) already wins over any
# assignment in this file regardless, this just keeps the intent explicit.
# '-dirty' suffix: this box's working tree sits dirty between deploys, and a
# clean HEAD tag can equal .deploy/last-good — building then would silently
# retag the currently-deployed/rollback image with different bits.
ifeq ($(origin IMAGE_TAG),file)
prod-build: IMAGE_TAG = $(shell git rev-parse --short HEAD 2>/dev/null || echo latest)$(shell git diff --quiet HEAD 2>/dev/null || echo -dirty)
endif
prod-build:
	@[ "$(IMAGE_TAG)" != "$$(cat .deploy/last-good 2>/dev/null)" ] || { echo "refusing to overwrite the deployed/rollback tag $(REGISTRY_PREFIX)/<svc>:$(IMAGE_TAG) - commit first, or pass IMAGE_TAG=<explicit-tag>"; exit 1; }
	$(PROD_COMPOSE) build $(service)
	@echo "Built $(if $(service),$(service),all images) as $(REGISTRY_PREFIX)/<svc>:$(IMAGE_TAG)."
	@echo "Deploy stays manual — see 'make prod-deploy' (make help)."

# ── Production DEPLOYMENT (migrated from scripts/deploy-prod.sh — this is now
#    the ONLY implementation; that script no longer exists) ──────────────────
#
# Same guarantees the script had: refuses a dirty tree or the wrong branch,
# serializes concurrent runs with flock, fast-forward-only git sync (never a
# destructive reset except inside the FAILURE-triggered rollback, which resets
# only back to the commit this same run started from), SHA-tagged images with
# a `latest` alias kept pointing at whatever's actually live, a health gate
# with a real per-container poll (handles replicas), a real-browser smoke
# test, automatic rollback on any failure, and bounded image retention.
#
# Design note: this file cannot literally run the script — "do not create
# another deployment script" is a hard constraint — so the logic lives here as
# a `define` block of bash FUNCTIONS (DEPLOY_LIB), textually inlined into each
# target's recipe. That gives every target below its own independent,
# self-contained shell invocation (needed for prod-deploy's `trap ... ERR` to
# reliably catch a failure anywhere in the pipeline and roll back — Make's own
# per-line error handling can't do that), while still sharing one copy of each
# function's logic instead of N copies.
DEPLOY_LOCK_FILE     := /tmp/blisswork-deploy.lock
DEPLOY_STATE_DIR     := .deploy
DEPLOY_LAST_GOOD     := $(DEPLOY_STATE_DIR)/last-good
HEALTH_TIMEOUT       ?= 420
KEEP_IMAGE_TAGS      ?= 3

# Exactly the sets scripts/deploy-prod.sh used. Keep in sync with
# docker-compose.prod.yml by hand — there is no way to derive "these are the
# ones we build, health-check, and roll" from the compose file itself without
# adding a `profiles:`/label convention it doesn't have today.
DEPLOY_BUILT_SERVICES  := auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc sticky-svc sticky-relay ws-gateway graph-gw caddy
DEPLOY_SHA_IMAGES      := auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc sticky-svc sticky-relay ws-gateway graph-gw caddy-waf
DEPLOY_HEALTH_SERVICES := auth-svc task-svc notification-svc messaging-svc integrations-svc telemetry-svc sticky-svc sticky-relay ws-gateway graph-gw nginx caddy
DEPLOY_CORE_SERVICES   := postgres redis kafka kafka-init livekit coturn auth-svc email-worker task-svc notification-svc messaging-svc integrations-svc telemetry-svc sticky-svc sticky-relay ws-gateway graph-gw caddy nginx

# Deliberately EXCLUDES the observability stack (otel-collector, prometheus,
# the exporters, cadvisor, alertmanager, tempo, loki, grafana) — none of those
# declare a compose `profiles:` key, so an unscoped `up -d` over the whole
# file would sweep them into every deploy. Also excludes delivery-svc
# (`profiles: [routed]`) and desktop-builder (`profiles: [desktop]`), which
# are already opt-in via those profiles and need no listing here.
DEPLOY_COMPOSE_ARGS := --env-file .env --env-file .env.prod -f docker-compose.prod.yml$(if $(REGISTRY), -f docker-compose.registry.yml)

define DEPLOY_LIB
log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$$*" >&2; exit 1; }

DEPLOY_LOCK_FILE="$(DEPLOY_LOCK_FILE)"
DEPLOY_LAST_GOOD="$(DEPLOY_LAST_GOOD)"
DEPLOY_STATE_DIR="$(DEPLOY_STATE_DIR)"
REGISTRY_PREFIX="$(REGISTRY_PREFIX)"
PULL_MODE=$(if $(REGISTRY),1,0)
HEALTH_TIMEOUT="$(HEALTH_TIMEOUT)"
KEEP_IMAGE_TAGS="$(KEEP_IMAGE_TAGS)"
COMPOSE_ARGS=($(DEPLOY_COMPOSE_ARGS))
BUILT_SERVICES=($(DEPLOY_BUILT_SERVICES))
SHA_TAGGED_IMAGES=($(DEPLOY_SHA_IMAGES))
HEALTH_SERVICES=($(DEPLOY_HEALTH_SERVICES))
CORE_SERVICES=($(DEPLOY_CORE_SERVICES))

# IMAGE_TAG must reach compose EXPLICITLY: sudo sanitizes the environment, so
# a merely-exported IMAGE_TAG silently does not survive `sudo docker compose`
# and compose falls back to the IMAGE_TAG in .env (`latest`). Not cosmetic —
# it is what breaks rollback (the previous tag would never actually apply).
compose() {
	$(SUDO) env IMAGE_TAG="$${IMAGE_TAG:-latest}" REGISTRY_PREFIX="$$REGISTRY_PREFIX" \
		docker compose "$${COMPOSE_ARGS[@]}" "$$@"
}

deploy_guard() {
	local branch dirty count
	branch="$$(git rev-parse --abbrev-ref HEAD)"
	dirty="$$(git status --porcelain)"

	if [ "$${DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
		warn "DEPLOY_ALLOW_DIRTY=1 — branch/clean-tree guard skipped."
		warn "Deploying whatever is in the working tree. Never set this in CI."
		return 0
	fi

	if [ "$$branch" != "Prod-Sid" ]; then
		die "Refusing to deploy: on branch '$$branch', expected 'Prod-Sid'. Switch it to Prod-Sid, or set DEPLOY_ALLOW_DIRTY=1 if you are deliberately deploying a branch by hand."
	fi

	if [ -n "$$dirty" ]; then
		count="$$(printf '%s\n' "$$dirty" | wc -l)"
		printf '%s\n' "$$dirty" | head -20 >&2
		[ "$$count" -le 20 ] || warn "… and $$((count - 20)) more"
		die "Refusing to deploy: the working tree has $$count uncommitted change(s) (above). Commit, stash, or merge it first."
	fi
}

deploy_fetch() {
	log "Fetching origin"
	git fetch --prune origin
	local branch
	branch="$$(git rev-parse --abbrev-ref HEAD)"
	if ! git merge --ff-only "origin/$$branch"; then
		if [ "$${DEPLOY_ALLOW_DIRTY:-0}" = "1" ]; then
			warn "Fast-forward skipped (DEPLOY_ALLOW_DIRTY=1); deploying the current tree."
		else
			die "Cannot fast-forward to origin/$$branch — the host has diverged. Resolve by hand."
		fi
	fi
}

deploy_build_or_pull_images() {
	if [ "$$PULL_MODE" = "1" ]; then
		log "Pulling images from $$REGISTRY_PREFIX (tag $$IMAGE_TAG)"
		# Only the images this project publishes — nginx because in pull mode
		# it IS the web bundle image (see docker-compose.registry.yml).
		compose pull "$${BUILT_SERVICES[@]}" nginx
	else
		log "Building service images"
		compose build "$${BUILT_SERVICES[@]}"
		# Keep `:latest` pointing at the live set so a bare `docker compose up
		# -d` with no IMAGE_TAG exported still starts what's actually
		# deployed. In pull mode the registry publishes its own `:latest`.
		local img
		for img in "$${SHA_TAGGED_IMAGES[@]}"; do
			$(SUDO) docker tag "$$REGISTRY_PREFIX/$$img:$$IMAGE_TAG" "$$REGISTRY_PREFIX/$$img:latest"
		done
	fi
}

deploy_core() {
	log "Rolling services (each service runs its migrations at boot)"
	compose up -d --remove-orphans "$${CORE_SERVICES[@]}"
}

deploy_web_bundle() {
	if [ "$$PULL_MODE" = "1" ]; then
		# The bundle is baked into the nginx image, and deploy_core already
		# recreated nginx because its image tag changed. Nothing to build,
		# no volume to fill — see docker-compose.registry.yml.
		log "Web bundle ships inside the nginx image — nothing to build"
		return 0
	fi
	log "Building web bundle (web-builder one-shot)"
	compose run --rm --no-deps web-builder
	log "Recreating nginx"
	compose up -d --force-recreate nginx
}

deploy_wait_healthy() {
	local deadline=$$((SECONDS + HEALTH_TIMEOUT))
	local svc cid status
	local -a cids pending

	while :; do
		pending=()
		for svc in "$${HEALTH_SERVICES[@]}"; do
			# `ps -q` prints one container ID per line for a replicated
			# service (auth-svc, task-svc, etc. run 2 replicas) — inspect
			# each separately rather than joining them into one `docker
			# inspect` call, which can't report a multi-line status cleanly.
			mapfile -t cids < <(compose ps -q "$$svc" 2>/dev/null)
			if [ "$${#cids[@]}" -eq 0 ]; then
				pending+=("$$svc(missing)")
				continue
			fi
			for cid in "$${cids[@]}"; do
				status="$$($(SUDO) docker inspect \
					--format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
					"$$cid" 2>/dev/null || echo unknown)"
				[ "$$status" = "healthy" ] || pending+=("$$svc($$status)")
			done
		done

		[ "$${#pending[@]}" -eq 0 ] && return 0

		if [ "$$SECONDS" -ge "$$deadline" ]; then
			warn "not healthy after $${HEALTH_TIMEOUT}s: $${pending[*]}"
			for svc in "$${HEALTH_SERVICES[@]}"; do
				printf -- '--- %s ---\n' "$$svc" >&2
				compose logs --tail 40 "$$svc" >&2 2>&1 || true
			done
			return 1
		fi
		sleep 5
	done
}

deploy_smoke_test() {
	local domain
	domain="$$(grep -E '^DOMAIN=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
	if [ -z "$$domain" ]; then
		warn "DOMAIN not set in .env — skipping the HTTPS smoke test."
		return 0
	fi
	log "Smoke test: https://$$domain/"
	curl -fsS --max-time 20 "https://$$domain/" -o /dev/null

	# A 200 status cannot tell you the app WORKS — smoke-web.mjs loads it in a
	# real browser and fails on an uncaught error or an empty #root, and
	# degrades to asset checks (and says so) where no browser is available.
	log "Smoke test: does the app boot?"
	node scripts/smoke-web.mjs "https://$$domain"
}

# $1 = prev_sha to `git reset --hard` to; EMPTY skips the reset. Used both by
#      prod-deploy's automatic failure path (real prev_sha, from just before
#      this run advanced the tree) and by standalone `make prod-rollback`
#      (empty — there is no "this run's start" to unwind to, only a known-good
#      image tag, and resetting git state from an unrelated manual invocation
#      would be its own destructive surprise).
# $2 = prev_tag to redeploy. Required.
deploy_rollback() {
	local prev_sha="$$1" prev_tag="$$2"
	[ -n "$$prev_tag" ] || die "rollback: no previous known-good tag recorded ($$DEPLOY_LAST_GOOD is empty or missing)."
	warn "Rolling back to $${prev_sha:-the current checkout} (images: $$prev_tag)"

	[ -z "$$prev_sha" ] || git reset --hard "$$prev_sha"

	if $(SUDO) docker image inspect "$$REGISTRY_PREFIX/auth-svc:$$prev_tag" >/dev/null 2>&1; then
		# Previous image set is still in the local store — a container
		# restart, not a rebuild.
		export IMAGE_TAG="$$prev_tag"
		compose up -d --remove-orphans "$${CORE_SERVICES[@]}"
	elif [ "$$PULL_MODE" = "1" ]; then
		warn "No local image set tagged '$$prev_tag' — pulling it from $$REGISTRY_PREFIX."
		export IMAGE_TAG="$$prev_tag"
		compose pull "$${BUILT_SERVICES[@]}" nginx
		compose up -d --remove-orphans "$${CORE_SERVICES[@]}"
	else
		warn "No local image set tagged '$$prev_tag' — rebuilding from it."
		export IMAGE_TAG="$$prev_tag"
		compose up -d --build --remove-orphans "$${CORE_SERVICES[@]}"
	fi
	deploy_web_bundle

	warn "Rollback complete: production is back on $$prev_tag."
}

# Keep the N most recent SHA tags per service so per-deploy tags can't fill
# the disk. `latest` is never a candidate (always points at the live set),
# and the currently-exported IMAGE_TAG is never pruned even if it would
# otherwise fall outside the retention window.
deploy_prune_old_images() {
	local img tag
	for img in "$${SHA_TAGGED_IMAGES[@]}"; do
		$(SUDO) docker images "$$REGISTRY_PREFIX/$$img" --format '{{.Tag}}|{{.CreatedAt}}' 2>/dev/null \
			| grep -v '^latest|' \
			| grep -v '^<none>|' \
			| sort -t'|' -k2 -r \
			| tail -n "+$$((KEEP_IMAGE_TAGS + 1))" \
			| cut -d'|' -f1 \
			| while read -r tag; do
				[ -n "$$tag" ] && [ "$$tag" != "$$IMAGE_TAG" ] || continue
				$(SUDO) docker rmi "$$REGISTRY_PREFIX/$$img:$$tag" >/dev/null 2>&1 || true
			  done
	done
}

# The full pipeline, in the same order and with the same failure semantics as
# the old script: guard → lock → fetch → compute tag → [trap armed] → build/
# pull → core → web → health → smoke → [trap disarmed] → save last-good →
# prune. Anything failing between the trap being armed and disarmed rolls
# back to exactly what was running before this call started.
deploy_run() {
	mkdir -p "$$DEPLOY_STATE_DIR"
	local prev_sha prev_tag new_sha
	prev_sha="$$(git rev-parse HEAD)"
	prev_tag="$$(cat "$$DEPLOY_LAST_GOOD" 2>/dev/null || true)"
	log "Current: $$prev_sha (images: $${prev_tag:-unknown})"

	deploy_fetch

	new_sha="$$(git rev-parse HEAD)"
	IMAGE_TAG="$${REQUESTED_TAG:-$$(git rev-parse --short HEAD)}"
	export IMAGE_TAG
	if [ -n "$${REQUESTED_TAG:-}" ]; then
		log "Deploying $$new_sha with caller-supplied image tag '$$IMAGE_TAG'"
	else
		log "Deploying $$new_sha as image tag '$$IMAGE_TAG'"
	fi

	# `trap - ERR` first thing INSIDE the handler: a failure during rollback
	# itself must not recurse. The final `exit 1` is deliberate even though
	# rollback succeeded — the DEPLOY still failed, and callers (Jenkins,
	# GitHub Actions) need that reflected in the exit code.
	trap 'trap - ERR; deploy_rollback "$$prev_sha" "$$prev_tag"; exit 1' ERR

	deploy_build_or_pull_images
	deploy_core
	deploy_web_bundle

	log "Waiting for healthchecks (timeout $${HEALTH_TIMEOUT}s)"
	deploy_wait_healthy

	deploy_smoke_test

	trap - ERR

	echo "$$IMAGE_TAG" > "$$DEPLOY_LAST_GOOD"
	log "Pruning old image tags (keeping $$KEEP_IMAGE_TAGS per service)"
	deploy_prune_old_images

	log "Deployed $$new_sha successfully."
}

endef

# `make prod-deploy IMAGE_TAG=x` (or IMAGE_TAG from the environment — Make
# auto-exports both forms into the recipe) must win over the git-HEAD-derived
# default. Same $(origin) trick prod-build already uses above: the top-level
# `IMAGE_TAG := $(shell cat .deploy/last-good ...)` sets origin to "file" —
# if a caller supplied their own, origin is "command line"/"environment
# override" instead, and REQUESTED_TAG below captures it. REQUESTED_TAG is
# deliberately NOT $(IMAGE_TAG) itself: that variable is fixed at Make-parse
# time (before this run's `git fetch` even happens), and deploy_run needs to
# fall back to the POST-fetch HEAD, not the pre-fetch one — so the fallback
# has to happen in bash, at bash's own runtime, exactly like the script did.
ifeq ($(origin IMAGE_TAG),file)
prod-deploy: REQUESTED_TAG :=
else
prod-deploy: REQUESTED_TAG := $(IMAGE_TAG)
endif

# Unattended by design (no confirm prompt): this is what CI/Jenkins runs
# non-interactively on every push, exactly like scripts/deploy-prod.sh always
# was — an interactive "Are you sure? [y/N]" would just hang on EOF and break
# every automatic deploy. Its safeguards are the guard/lock/health/smoke/
# rollback machinery below, not a prompt.
prod-deploy:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	REQUESTED_TAG="$(REQUESTED_TAG)"
	exec 9>"$$DEPLOY_LOCK_FILE"
	flock -n 9 || die "another deploy is already running (lock: $$DEPLOY_LOCK_FILE)"
	deploy_guard
	deploy_run

prod-guard:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	deploy_guard
	echo "OK — on Prod-Sid with a clean working tree (or DEPLOY_ALLOW_DIRTY=1)."

prod-fetch:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	deploy_fetch
	echo "Fast-forwarded to $$(git rev-parse --short HEAD)."

prod-deploy-images:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	IMAGE_TAG="$(IMAGE_TAG)"; export IMAGE_TAG
	deploy_build_or_pull_images

prod-deploy-core:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	IMAGE_TAG="$(IMAGE_TAG)"; export IMAGE_TAG
	deploy_core

prod-deploy-web:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	IMAGE_TAG="$(IMAGE_TAG)"; export IMAGE_TAG
	deploy_web_bundle

prod-health:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	IMAGE_TAG="$(IMAGE_TAG)"; export IMAGE_TAG
	log "Waiting for healthchecks (timeout $${HEALTH_TIMEOUT}s)"
	deploy_wait_healthy
	echo "All services healthy."

prod-smoke:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	deploy_smoke_test
	echo "Smoke test passed."

# Does NOT reset git state (see deploy_rollback's own header above) — only
# prod-deploy's automatic, failure-triggered rollback does that, because only
# it knows which commit this run actually started from.
prod-rollback:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	prev_tag="$$(cat "$$DEPLOY_LAST_GOOD" 2>/dev/null || true)"
	deploy_rollback "" "$$prev_tag"
	echo "Rollback finished — production is back on $$prev_tag."

prod-prune:
	@set -Eeuo pipefail
	$(DEPLOY_LIB)
	IMAGE_TAG="$(IMAGE_TAG)"
	deploy_prune_old_images
	echo "Pruned old SHA-tagged images (kept $$KEEP_IMAGE_TAGS per service)."

# ── Combo / shortcut targets ─────────────────────────────────────────────────
dev:
	$(MAKE) dev-up
	$(MAKE) wait

	$(MAKE) dev-ps
	@echo "Dev stack healthy. Web UI: 'make web-dev'  |  Desktop: 'make desktop-dev'"

prod:
	$(MAKE) prod-up
	$(MAKE) prod-ps

# ── Client apps ──────────────────────────────────────────────────────────────
# There is no native mobile workspace in this repo — phones use the responsive
# web app; web-build is what ships to them (in prod, via the web-builder
# compose service, not from a laptop).
web-dev:
	npm run web

web-build:
	npm run build -w @taskboard/web

# Rebuilds the web bundle from the working tree and PUBLISHES it to the live
# site: the one-shot web-builder writes into the web_dist volume, then nginx
# (which serves it) needs a RECREATE, not just an `up` — nginx's own container
# config doesn't change when the volume's CONTENTS do, so a plain `up` sees it
# as unchanged and leaves the stale bundle serving. One confirm covers both
# steps; they are only ever meaningful run together. User-facing, hence the
# gate — same reasoning as desktop-release below.
web-release:
	$(call confirm,rebuild the web bundle from the working tree and PUBLISH it to the live site)
	$(PROD_COMPOSE) up --no-build --no-deps web-builder
	$(PROD_COMPOSE) up -d --no-build --force-recreate --no-deps nginx

desktop-dev:
	npm run desktop

desktop-build:
	npm run package -w @taskboard/desktop

# Builds Linux + Windows(wine) installers inside electronuserland/builder and
# publishes them straight into the live /downloads feed (auto version bump —
# see scripts/next-desktop-version.mjs). That is user-facing, hence the gate.
desktop-release:
	$(call confirm,build desktop installers and PUBLISH them to the live download feed)
	$(PROD_COMPOSE) run --rm desktop-builder

# ── Utilities (exec/clean are service-aware; env=prod switches stack) ────────
exec:
	@test -n "$(service)" || { echo "usage: make exec service=<name> [env=prod]"; exit 1; }
	$(COMPOSE) exec $(service) sh -c 'command -v bash >/dev/null && exec bash || exec sh'

clean:
ifeq ($(env),prod)
	$(call confirm,remove the stopped/created containers of $(if $(service),prod service $(service),the PROD stack))
endif
	$(COMPOSE) rm -f $(service)

# Dangling images and build cache on the ONE shared Docker daemon — this
# always affects BOTH stacks together; service=/env= have no effect here
# (docker image/builder prune have no per-project or per-service scope).
# Never `image prune -a`: rollback is `IMAGE_TAG=<previous> up -d`, which
# needs the old tags kept on disk.
prune:
	$(SUDO) docker image prune -f
	$(SUDO) docker builder prune -f

# ── Legacy dev shortcuts (kept as-is, routed through DEV_COMPOSE for sudo) ───
env:
	@test -f .env || cp .env.example .env

keys:
	@npm run gen:keys --silent

up: env keys
	$(DEV_COMPOSE) up -d --build
	$(MAKE) wait
	$(MAKE) seed
	@echo "Stack is up. Web: run 'npm run web'  |  Desktop: run 'npm run desktop'"

wait:
	@bash scripts/wait-for.sh

seed:
	@npm run seed --silent

demo:
	@npm run demo --silent

logs:
	$(DEV_COMPOSE) logs -f

ps:
	$(DEV_COMPOSE) ps

down:
	$(DEV_COMPOSE) down

reset:
	$(DEV_COMPOSE) down -v

test:
	npm test --silent
	node scripts/check-migrations.mjs

check-migrations:
	node scripts/check-migrations.mjs