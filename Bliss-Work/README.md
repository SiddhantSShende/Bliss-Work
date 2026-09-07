# Task-Board (BlissWork)

Team collaboration platform, shipped as a web app and an Electron desktop app
from one shared React codebase:

- **Messaging** — 1:1 DMs (reply / ignore / block), **channels**, a unified
  people-centric inbox, typing indicators and live presence.
- **Tasks** — assign → acknowledge → complete, with a timeline, allocator
  review, and **.xlsx export**. Desktop pins assigned tasks to the desktop as
  sticky notes that sit behind every app until you show the desktop.
- **Calls & file transfer** — WebRTC audio/video plus peer-to-peer file
  transfer (streamed to disk on desktop, coturn for NAT traversal).
- **External integrations** — connect Slack, Gmail, Outlook and Teams
  with **your own** OAuth apps. The Hub surfaces only messages that *tagged you*,
  each with Claim (→ a task assigned to you) and Ignore.
- **Members & activity** — org admins change roles, suspend and remove members,
  and see each person's activity: sign-ins, online/idle/offline sessions, what
  they worked on, with charts and **.xlsx export**. Every member can see their
  own record. Channels have owners and admins who can add, remove and block.
- **Multi-org** — one login across several workspaces, with a top-bar switcher.
  Members can leave a workspace themselves from the Org page.

## Architecture

Microservices, database-per-service (PostgreSQL), Kafka event bus, Redis for
presence/cache, WebSocket gateway for realtime. React frontend shipped as both a
browser web app and an Electron desktop app from one shared codebase.

| Service | Lang | Port | Responsibility |
|---|---|---|---|
| `auth-svc` | Python/FastAPI | 8001 | orgs, users, invites, roles, EdDSA JWT + JWKS, `/directory` |
| `email-worker` | Python | — | consumes `invite.created` → Mailpit/SES |
| `task-svc` | Python/FastAPI | 8002 | tasks + per-assignee state machine, `/tasks/sticky` |
| `notification-svc` | Go | 8003 | persistent notification inbox |
| `messaging-svc` | Go | 8004 | conversations, channels, messages, ignore/block, forward-tracking |
| `integrations-svc` | Python/FastAPI | 8005 | external platform connections, OAuth, webhooks, Hub mentions |
| `telemetry-svc` | Python/FastAPI | 8006 | member activity record: sessions, activity timeline, rollups, .xlsx export |
| `graph-gw` | Node/TS | 8007 | **optional** read-composition GraphQL gateway over the REST services — see [`docs/GRAPH-GATEWAY.md`](docs/GRAPH-GATEWAY.md) |
| `ws-gateway` | Go | 8080 → host **8090** | WebSocket fan-out (consume-all-and-filter), WebRTC signaling, presence |

Clients connect to the WebSocket at `ws://localhost:8090/ws` (the gateway listens on
8080 inside the network; the host port is remapped to 8090 to avoid a common clash).
Postgres, Redis, and Kafka have **no** host port mappings — they're reached only over
the internal Docker network.

Infra (docker-compose): PostgreSQL 17, Redis 7.4, Kafka 3.9 (KRaft), Mailpit.

### Binding conventions (see the design doc)

- Tenant id is **`orgId`** everywhere; every event carries an **`eventId`** (UUIDv7) for dedup.
- JWT is **EdDSA (Ed25519) via JWKS** — `auth-svc` is the sole issuer; every service verifies via cached JWKS. No HS256.
- Each service **derives `orgId`/`userId` from the verified JWT** — it never trusts `x-org-id` headers (mesh-less MVP).
- The **canonical event/WS contract** lives in [`packages/shared/src/types/events.ts`](packages/shared/src/types/events.ts).
- Transactional **outbox** + in-process poller per writing service; consumers dedup on `eventId`.

## Quick start

Requires Docker and Node 20+ (npm comes with Node).

```bash
npm install
make up            # generates keys + .env, builds & starts the stack, seeds demo data
# Windows (no make): npm run gen:keys && cp .env.example .env && npm run up && npm run seed

npm run web        # browser app at http://localhost:5173
npm run desktop    # Electron app with desktop sticky widgets

make demo          # scripted end-to-end: message-ignore + task ack/complete
#   (no make? → npm run demo)
```

Demo org `acme` with users **alice / bob / carol** (password `Passw0rd!`) is seeded.
Mailpit UI (captured invite emails): http://localhost:8025

### Shipping updates (production host)

Both apps are built by Docker — no CI service is involved, so nothing can be
blocked by one being red.

```bash
# Web app + services. Rebuilds the browser bundle and rolls the services.
bash scripts/deploy-prod.sh

# Desktop app: Linux (AppImage + deb) AND Windows (.exe, built under Wine).
# Publishes straight into the live /downloads feed that electron-updater polls.
sudo docker compose -f docker-compose.prod.yml --profile desktop up desktop-builder

# Both in one go
sudo docker compose -f docker-compose.prod.yml --profile desktop up -d --build
```

The desktop build sits behind the `desktop` profile so a routine deploy — which
runs `compose up -d` — doesn't pay ~10 minutes for an Electron build it didn't
ask for.

The version is derived from the **published feed**, not `package.json`, and the
patch is bumped automatically (`scripts/next-desktop-version.mjs`). electron-updater
only offers an update when the feed version is strictly greater than what the user
is running, and `package.json` has long sat behind the feed. Override with
`DESKTOP_VERSION=1.2.0` for a minor/major bump.

**macOS is the one platform this cannot build.** Apple requires a `.dmg` to be
produced and signed on macOS. Its feed is left untouched, so mac users stay where
they are rather than being pointed at something that isn't there. Build on a Mac
and publish with `bash scripts/publish-desktop.sh <dir>`.

## Features

- **Communication:** send a message → recipient sees Reply / Ignore. **Ignore** removes the
  conversation from **both** users' lists; **Reply** keeps it (and revives an ignored thread).
- **Task:** create a task (title + description) → assignees see Acknowledge / Ignore.
  **Acknowledge** notifies the sender and unlocks Complete / Leave; **Complete** notifies the
  sender. **Ignore** removes it from both views.
- **Desktop sticky widget:** assigned tasks pin to the desktop as frameless widgets that sit
  *behind* every application window — visible when the desktop is — with inline actions.

## Docs

| Doc | What it covers |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | The CI/CD pipeline, required secrets, manual deploy + rollback |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Backups, key rotation, WAF rollout |
| [`docs/GRAPH-GATEWAY.md`](docs/GRAPH-GATEWAY.md) | The GraphQL gateway: what it fronts, what it must never front, trusted documents |
| [`docs/TELEMETRY.md`](docs/TELEMETRY.md) | What the activity record collects, retention, the nightly jobs |
| [`apps/desktop/STORE.md`](apps/desktop/STORE.md) | Microsoft Store submission |

## Layout

```
packages/{shared,ui,app}          apps/{web,desktop}
services/{auth-svc,email-worker,task-svc,notification-svc,messaging-svc,integrations-svc,telemetry-svc,ws-gateway,graph-gw}
infra/{postgres,kafka,nginx,caddy}
scripts/   (seed.ts, gen-keys.ts, wait-for.sh, deploy-prod.sh, security-authz.ts)
```

Every source file is kept under 250 lines.
