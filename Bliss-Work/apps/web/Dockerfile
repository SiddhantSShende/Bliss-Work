# syntax=docker/dockerfile:1
#
# The web SPA as a pullable image.
#
# WHY THIS EXISTS: production currently builds the bundle with the one-shot
# `web-builder` service in docker-compose.prod.yml — a node container that
# bind-mounts the whole repo and writes into the `web_dist` volume. That works
# only when the build happens ON the production host. A build VM has no repo to
# mount and no volume to write into, so the bundle has to become an artifact
# that can be pushed to a registry and pulled. This is that artifact.
#
# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not apps/web ──────────────────────
# @taskboard/web depends on three sibling workspaces (@taskboard/app,
# @taskboard/shared, @taskboard/ui), and all three export raw ./src/*.ts that
# Vite compiles from source — there is no per-package build step. So the build
# needs the whole workspace:
#
#     docker build -f apps/web/Dockerfile --build-arg VITE_BUILD_SHA=$(git rev-parse --short HEAD) .
#
# .dockerignore at the repo root keeps that context to roughly source size.
#
# ── ADOPTING IT ─────────────────────────────────────────────────────────────
# This file changes nothing on its own. To cut production over, point the nginx
# service at this image instead of the web_dist volume and drop web-builder and
# its `depends_on: service_completed_successfully`. Until then both paths
# coexist and production keeps building the bundle the way it always has.

# ── Build stage ─────────────────────────────────────────────────────────────
# Same node digest the web-builder service already pins, so the bundle produced
# here is byte-comparable with the one production builds today.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

ENV npm_config_update_notifier=false \
    # `npm ci` at the root installs every workspace, and the root devDependencies
    # include electron and playwright. Their postinstall steps would pull ~500 MB
    # of binaries that a Vite build never touches. Skipping them is the whole
    # difference between a two-minute and a ten-minute cold build.
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace

# Manifests and the lockfile first, so the install layer is reused for every
# commit that does not change the dependency graph. Every workspace listed in
# the root `workspaces` glob must be present or `npm ci` cannot resolve the tree.
COPY package.json package-lock.json .npmrc ./
COPY packages/app/package.json       packages/app/
COPY packages/shared/package.json    packages/shared/
COPY packages/ui/package.json        packages/ui/
COPY apps/web/package.json           apps/web/
COPY apps/desktop/package.json       apps/desktop/
COPY apps/extension/package.json     apps/extension/
# @taskboard/graph-gw is a workspace too (it imports @taskboard/shared, which
# is what keeps its schema and the REST contract from drifting). Its manifest
# must be present or `npm ci` cannot resolve the tree — even though the web
# bundle never imports a line of it.
COPY services/graph-gw/package.json  services/graph-gw/

# ── Why --ignore-scripts ────────────────────────────────────────────────────
# `npm ci` at the root installs every workspace, and apps/desktop depends on
# get-windows — a native module with no musl prebuild. Its install script tries
# to compile against Windows headers on Alpine, fails, and takes the whole
# install with it, so this image could not build at all.
#
# Skipping lifecycle scripts is safe for a Vite build: esbuild and @swc/core
# both ship their platform binaries as optional dependency PACKAGES rather than
# as a postinstall download, so npm places them without running anything. Not
# executing arbitrary install-time code in a build that produces a public bundle
# is worth having on its own.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts

# Sources last: these change on nearly every commit, so nothing above should
# depend on them.
COPY packages/ packages/
COPY apps/web/ apps/web/

# ── The bundle is environment-specific, and that is not a choice this file
#    makes. apps/web/vite.config.ts REFUSES to produce a production bundle
#    unless all seven service URLs below are set:
#
#      Refusing to build a production bundle without: VITE_AUTH_BASE, …
#
#    They are baked into the JavaScript, so ONE WEB IMAGE CANNOT BE PROMOTED
#    from staging to production the way the service images can — a bundle built
#    for one domain points at that domain forever. Build a separate tag per
#    environment. (They are not secrets: every one of them ships inside a public
#    bundle that any visitor can read.)
#
#    Today these reach the build through `env_file: .env.prod` on the
#    web-builder service. Here they are build args, so the build VM needs no
#    copy of the production secrets file — only the domain.
ARG WEB_DOMAIN=communication.rnrtechs.com

# Derived from WEB_DOMAIN, which is the only value that changes in practice.
# Override any of them individually if the API is ever split onto another host.
ARG VITE_AUTH_BASE=https://${WEB_DOMAIN}/api/auth
ARG VITE_TASK_BASE=https://${WEB_DOMAIN}/api/tasks
ARG VITE_NOTIFICATION_BASE=https://${WEB_DOMAIN}/api/notifications
ARG VITE_MESSAGING_BASE=https://${WEB_DOMAIN}/api/messaging
ARG VITE_INTEGRATIONS_BASE=https://${WEB_DOMAIN}/api/integrations
ARG VITE_TELEMETRY_BASE=https://${WEB_DOMAIN}/api/telemetry
ARG VITE_WS_URL=wss://${WEB_DOMAIN}/ws

# The read-composition GraphQL gateway. EMPTY BY DEFAULT and deliberately so: an
# unset value makes every screen take its REST path, so the gateway is opted
# into per build rather than switched on for everyone the moment it exists.
# Turn it on with --build-arg VITE_GRAPH_BASE=https://${WEB_DOMAIN}/graphql
ARG VITE_GRAPH_BASE=

# Stamped into the bundle so Settings → About reports which commit is live.
# Vite only exposes VITE_-prefixed vars to client code. Defaults to "dev" for a
# hand-run build, matching web-builder's behaviour.
ARG VITE_BUILD_SHA=dev

ENV VITE_BUILD_SHA=$VITE_BUILD_SHA \
    VITE_AUTH_BASE=$VITE_AUTH_BASE \
    VITE_TASK_BASE=$VITE_TASK_BASE \
    VITE_NOTIFICATION_BASE=$VITE_NOTIFICATION_BASE \
    VITE_MESSAGING_BASE=$VITE_MESSAGING_BASE \
    VITE_INTEGRATIONS_BASE=$VITE_INTEGRATIONS_BASE \
    VITE_TELEMETRY_BASE=$VITE_TELEMETRY_BASE \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_GRAPH_BASE=$VITE_GRAPH_BASE

RUN npm run build -w @taskboard/web

# ── Runtime stage ───────────────────────────────────────────────────────────
# The site config stays a bind-mount (infra/nginx/default.conf) rather than being
# baked in: routing and cache headers are operational settings that should be
# tunable without a rebuild, and that is how the running nginx service is already
# wired.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
