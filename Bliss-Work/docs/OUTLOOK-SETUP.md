# Microsoft 365 / Outlook integration — setup

How to make Settings > Microsoft 365 connectable for a deployment, and what
`integrations-svc` does with the result. This supersedes the old
`docs/INTEGRATIONS-SETUP.md` (deleted 2026-08-31 along with the generic
multi-provider hub UI it documented) — only Outlook has a real UI today.

## What this unlocks

- A member connects their own Outlook/Microsoft 365 mailbox from
  **Settings > Microsoft 365**.
- Mail composed in BlissWork's Mail module sends through that member's own
  mailbox (real `From:` address, DKIM-aligned, filed in their Sent folder)
  instead of the deployment's shared SMTP relay.
- New mail arriving in the connected mailbox's Inbox, and mail sent or
  replied to directly in Outlook (Sent Items), import into that member's
  BlissWork Mail module.
- Read/unread and delete state sync in both directions, scoped to that one
  member's own mailbox only — never a colleague's.

Without any of the configuration below, Outlook is simply not connectable:
the feature fails closed, not open. Gmail/Teams/Slack share the same
underlying connected-account system but have no frontend UI to start a
connection — this doc is Outlook-specific.

## 1. Register an Entra (Azure AD) app

In the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** →
**App registrations** → **New registration**:

- **Supported account types**: "Accounts in any organizational directory and
  personal Microsoft accounts" (multi-tenant + personal), unless you are
  deliberately restricting this deployment to one tenant — see `MS_TENANT`
  below.
- **Redirect URI** (platform: Web): exactly
  `${PUBLIC_BASE_URL}/ext/outlook/oauth/callback` — e.g.
  `https://app.example.com/ext/outlook/oauth/callback`. Must match byte for
  byte; Caddy routes `/ext/*` to `integrations-svc` in both
  `docker-compose.yml`/`docker-compose.prod.yml`.
- **API permissions** (Microsoft Graph, **delegated**):
  - `openid`, `profile`, `email`, `offline_access`, `User.Read` — identity +
    refresh tokens.
  - `Mail.Read` — inbound sync (delta queries over Inbox and Sent Items).
  - `Mail.Send` — sending as the connected member.
  - `Mail.ReadWrite` — write-back only: mirroring a BlissWork-side read or
    delete action out to the member's own Outlook message. This is the one
    permission here that is not a rubber-stamp — some tenants require admin
    consent for it. If your org's Entra policy blocks user consent for
    `Mail.ReadWrite`, an admin must grant consent for the app once (**App
    registrations > your app > API permissions > Grant admin consent**)
    before any member in that tenant can connect.
- **Certificates & secrets** → **New client secret**. Copy the value
  immediately; Azure will not show it again.

## 2. Configure the deployment

Set in `.env.prod` (see `.env.prod.example` for the annotated block):

```
PUBLIC_BASE_URL=https://app.example.com   # must already be correct — see below
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<the client secret value>
MS_TENANT=common                          # or your tenant id for single-tenant apps
```

`PUBLIC_BASE_URL` is not specific to Outlook — every OAuth redirect and
webhook callback `integrations-svc` builds comes from it, and the service
refuses to start in production without it set at all (see
`app/config.py::_enforce_prod_safety`). It is almost always the same origin
as `WEB_ORIGIN`.

An org admin can alternatively register their own Entra app per-workspace via
`PUT /api/v1/integrations/app-credentials/outlook` instead of the shared
`MS_CLIENT_ID`/`MS_CLIENT_SECRET` env fallback — useful for a multi-tenant
deployment where different customers must not share one Entra app. The env
vars above are the fallback used when an org has not done this.

## 3. The webhook requirement (read this before testing against `localhost`)

Outlook sync creates a Microsoft Graph **subscription** (push notification)
on the connected mailbox's Inbox, so new mail is picked up within seconds
rather than waiting for the ~60s poll alone. Creating that subscription
calls `${PUBLIC_BASE_URL}/ext/outlook/notifications` **synchronously** —
Graph POSTs a validation token to it and expects it echoed back within 10
seconds, during the very same API call that creates the subscription.

This means:

- `PUBLIC_BASE_URL` must be a real, publicly reachable **HTTPS** URL at the
  moment anyone connects — not `http://localhost:...`. Testing locally
  requires a tunnel (ngrok, Cloudflare Tunnel, etc.) with `PUBLIC_BASE_URL`
  pointed at it.
- If the subscription create fails (unreachable URL, wrong TLS, firewall),
  the connection itself still succeeds — subscription creation is best-effort
  and retried by `mail_sync_worker`'s periodic sweep — but mail only arrives
  on the ~60s poll, never faster, until it succeeds. This fails silently: it
  will look like Outlook sync is slow, not broken.
- Sent Items has no push subscription (a deliberate scope cut — see
  `mail_sync_worker.py`'s module docstring); it is always polled.

## 4. Database migration and worker

`integrations-svc/migrations/0019_mail_sync_links.sql` adds the one new
table this feature needs (everything else — OAuth state, token storage,
push-subscription/ingest-cursor columns — already existed from the
multi-provider connected-account system). It applies automatically on boot,
same as every migration here (`app/db.py::run_migrations`).

`mail_sync_worker` (the Inbox/Sent-Items delta walk + subscription renewal)
and the mail-owner-state-changed Kafka consumer (write-back) both run
in-process inside the `integrations-svc` container — no separate worker
deployment, no extra `docker-compose` service. They start and stop with the
FastAPI app's lifespan, same as the existing OAuth-refresh worker.

## 5. Verifying a deployment

1. Confirm `MS_CLIENT_ID`/`MS_CLIENT_SECRET`/`PUBLIC_BASE_URL` are set and
   `PUBLIC_BASE_URL` is reachable over HTTPS from the public internet.
2. Settings > Microsoft 365 > Connect to Microsoft; complete the Microsoft
   consent screen.
3. `SELECT provider, status, scopes FROM integration_connections WHERE
   provider = 'outlook';` should show one `connected` row with
   `Mail.Read`/`Mail.ReadWrite`/`Mail.Send` in scopes.
4. Send a mail from BlissWork's Mail module as the connected member; confirm
   it lands in their real Outlook Sent folder.
5. Send a mail to that mailbox from an outside address; confirm it appears
   in BlissWork's Mail module within about a minute (sooner if the webhook
   subscription succeeded — see §3).
