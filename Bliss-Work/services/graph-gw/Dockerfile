# syntax=docker/dockerfile:1
#
# graph-gw — the read-composition GraphQL gateway.
#
# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/graph-gw ─────────────
# Unlike the Python and Go services, this one is a workspace member: it imports
# @taskboard/shared for the DTO schemas, the error vocabulary and the operation
# registry. That import is the whole reason the gateway is written in Node — it
# is what stops the schema and the REST contract from drifting apart — so the
# build needs the workspace:
#
#     docker build -f services/graph-gw/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build

ENV npm_config_update_notifier=false \
    # The root devDependencies include electron and playwright, whose postinstall
    # steps pull ~500 MB of binaries this service never touches.
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace

# Manifests and the lockfile first so the install layer survives source changes.
# Every workspace in the root `workspaces` glob must be present or `npm ci`
# cannot resolve the tree — the same constraint apps/web/Dockerfile documents.
COPY package.json package-lock.json .npmrc ./
COPY packages/app/package.json       packages/app/
COPY packages/shared/package.json    packages/shared/
COPY packages/ui/package.json        packages/ui/
COPY apps/web/package.json           apps/web/
COPY apps/desktop/package.json       apps/desktop/
COPY services/graph-gw/package.json  services/graph-gw/

# ── Why --omit=dev --ignore-scripts ─────────────────────────────────────────
# `npm ci` at the root installs the whole workspace, including workspaces this
# service never imports. Two of their packages cannot be built here:
#
#   * electron and playwright (dev) pull ~500 MB of binaries — hence --omit=dev,
#     which is also why tsx sits in this service's `dependencies`.
#   * get-windows (a PRODUCTION dependency of apps/desktop) is a native module
#     with no musl prebuild, so its install script tries to compile against
#     Windows headers on Alpine and fails the whole install.
#
# --ignore-scripts skips every package's lifecycle script. Nothing this gateway
# depends on needs one — graphql, yoga, dataloader and zod are pure JavaScript,
# and esbuild (under tsx) ships its binary as a platform package rather than a
# postinstall download. Not running arbitrary install-time code is worth having
# on a network-facing service regardless.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts

COPY packages/shared/       packages/shared/
COPY services/graph-gw/     services/graph-gw/

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS final

ENV NODE_ENV=production \
    npm_config_update_notifier=false

# Non-root, matching the uid the other service images run as.
RUN addgroup -g 10001 -S appuser && adduser -u 10001 -S appuser -G appuser

WORKDIR /workspace

# ── Why the service runs its TypeScript rather than a compiled bundle ────────
# @taskboard/shared exports raw ./src/*.ts and has no build step — every other
# consumer compiles it from source (Vite does, for both apps). Adding a build
# pipeline for one service would make it the only workspace that needs one, and
# would put a second copy of the DTOs on disk to drift from the first. tsx is a
# pinned dependency, not a dev convenience, for exactly that reason.
COPY --from=build /workspace/node_modules      ./node_modules
COPY --from=build /workspace/package.json      ./package.json
COPY --from=build /workspace/packages/shared   ./packages/shared
COPY --from=build /workspace/services/graph-gw ./services/graph-gw

RUN chown -R appuser:appuser /workspace

USER appuser

EXPOSE 8007

# Plain HTTP so the probe never has to speak GraphQL or hold a token.
# 127.0.0.1, NOT localhost. Node's listen(port, "0.0.0.0") binds IPv4 only,
# while busybox wget resolves `localhost` to ::1 first and gets connection
# refused — so this probe could never pass. The Go services next door DO use
# `localhost` and are fine, because Go's net.Listen binds dual-stack.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8007/healthz || exit 1

WORKDIR /workspace/services/graph-gw
CMD ["npx", "tsx", "src/index.ts"]
