# Connecting an external platform

BlissWork integrations are **user-driven**: your workspace brings its own
third-party app rather than authorizing a central BlissWork one. Your data stays
under your own agreements with Google/Microsoft/Slack/Meta, and one workspace's
review or rate limit never affects another's.

Everything below is done in the app under **Integrations**, plus a few minutes in
the provider's own console.

---

## Slack

One person sets this up for the whole workspace.

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) → *From scratch*.
2. **OAuth & Permissions** → add bot scopes: `chat:write`, `channels:read`,
   `users:read`, `im:history`. Install to your workspace and copy the
   **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. In BlissWork: **Integrations → Connected accounts → Slack → Connect**, paste both.
5. The connection now shows a **webhook URL**. Copy it.
6. Back in Slack: **Event Subscriptions** → enable, paste the URL. Slack sends a
   verification request immediately and must show *Verified*.
7. Subscribe to bot events: `message.channels`, `message.im`.

> **Why the URL is per-connection.** Slack's verification request carries no team
> id, so there is nothing in it to look your signing secret up by. Putting a token
> in the path means we can find your connection — and your secret — before trusting
> any part of the request. The token isn't what authenticates deliveries; Slack's
> HMAC signature still does, exactly as before.

**Mentions:** `@you` in a channel or DM the bot can see. `@here` / `@channel` are
deliberately ignored — they'd recreate the firehose the mentions feed exists to
replace.

---

## Gmail

Gmail, Outlook and Teams need a **workspace app** first — one per vendor, set up
once, then everyone connects their own account.

### Step 1 — create the Google app (once per workspace)

1. [Google Cloud Console](https://console.cloud.google.com) → create or pick a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **OAuth consent screen** → configure it (External unless you're Workspace-only).
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under *Authorized redirect URIs*, add the URI BlissWork shows you in
   **Integrations → Workspace apps → Google → Set up**. Copy it from there —
   don't retype it.
6. Copy the **Client ID** and **Client secret** into that same dialog and save.

> ⚠️ **Google verification is required before this leaves testing.**
> `gmail.readonly` is a *restricted* scope. Until your app completes Google's
> OAuth verification — which for restricted scopes also requires a third-party
> CASA security assessment — only accounts on your app's **test users** list can
> connect. This is Google's policy, not a BlissWork limitation, and the review
> takes weeks. Plan for it.

### Step 2 — each person connects their own mailbox

**Connected accounts → Gmail → Connect**, sign in, approve.

Connecting immediately makes mail addressed to that mailbox count as tagging you —
no separate handle setup. **Mentions:** your address in `To` or `Cc`. Bulk mail
(`List-Id`, `List-Unsubscribe`, `Precedence: bulk`, auto-replies) and mail from
yourself are excluded.

---

## Outlook and Microsoft Teams

Both run on **one** Entra app registration, so setting up Microsoft once unlocks
both.

### Step 1 — create the Microsoft app (once per workspace)

1. [Entra admin center](https://entra.microsoft.com) → **App registrations → New registration**.
2. Supported account types: *Accounts in any organizational directory* for
   multi-tenant, or single-tenant if you prefer.
3. **Certificates & secrets → New client secret** → copy the **Value** (not the
   Secret ID — they look similar and only the Value works).
4. **Authentication → Add a platform → Web** → add **both** redirect URIs shown in
   **Workspace apps → Microsoft → Set up** (one for Outlook, one for Teams).
5. Paste the **Application (client) ID** and the secret into that dialog.
6. Only if your app is single-tenant, also paste the **Directory (tenant) ID**.
   Leave it blank for multi-tenant — a single-tenant app authorized through
   `/common` fails with `AADSTS50194`, which is not self-explanatory.

### Step 2 — each person connects

**Connected accounts → Outlook** (or **Microsoft Teams**) **→ Connect**.

**Mentions:** Outlook is the same rule as Gmail. Teams matches
`mentions[].mentioned.user.id` — the AAD object id, which is why connecting
registers that id as a handle alongside your address. `@team` mentions are ignored.

---

## Rotating or removing credentials

Re-saving a workspace app rotates it. A rotation mid-consent is safe: each
in-flight authorization is pinned to the credential row it started with, so a
user sitting on the consent screen still completes successfully.

Removing a workspace app stops new connections. **Accounts already connected keep
working** until their access expires — then they move to `error` with a message,
rather than disconnecting everyone the moment an admin clicks Remove.

## What is stored, and where

| Value | Storage |
|---|---|
| Client secret, access + refresh tokens, signing secrets | Encrypted at rest (per-org AES-256-GCM envelope). Never returned to any client. |
| Client ID | Encrypted at rest; **readable** in the UI — it isn't secret (it travels in the authorize URL your browser follows). |
| Webhook token | Plaintext — it must be looked up on an unauthenticated path before any org context exists. It authenticates nothing on its own. |

## Troubleshooting

**`redirect_uri_mismatch`** — the registered URI differs from the one we send, by
a trailing slash, `http` vs `https`, or a missing path. Copy it from the setup
dialog rather than typing it.

**Slack shows "Your URL didn't respond with the value of the challenge parameter"**
— either the URL was pasted without its token suffix, or the signing secret in
BlissWork doesn't match the app you're configuring.

**`invalid_client` at the end of a Google/Microsoft sign-in** — the client secret
is wrong. For Microsoft, check you copied the secret's *Value* and not its *ID*.

**Connected, but no mentions appear** — mentions are deliberately narrow. Confirm
the message actually tagged you (not `@here`/`@channel`, not a bulk email), and
check **My handles** lists the address or id the platform uses for you.
