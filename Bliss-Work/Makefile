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
REGISTRY_PREFIX ?= task-board

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
	dev prod web-dev web-build desktop-dev desktop-build desktop-release \
	extension-build exec clean prune

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
	@echo "  make prod         - prod-up + status"
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
	@echo "Client apps (desktop is Electron; mobile = the responsive web app, no native workspace):"
	@echo "  make web-dev          - Vite dev server for the web app"
	@echo "  make web-build        - production build of the web app"
	@echo "  make desktop-dev      - run the desktop app against the dev stack"
	@echo "  make desktop-build    - package installers locally (electron-builder)"
	@echo "  make desktop-release  - CONFIRM, then build Linux+Windows installers in the"
	@echo "                          builder container and PUBLISH them to the live downloads"
	@echo "                          (DESKTOP_VERSION=x.y.z overrides the auto patch bump)"
	@echo "  make extension-build  - build the browser extension"
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
	@echo "Deploy stays manual — see the runbook in scripts/deploy-prod.sh."

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

extension-build:
	npm run build -w @taskboard/extension

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