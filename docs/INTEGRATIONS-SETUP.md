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

## WhatsApp (Business Cloud API)

**WhatsApp Business accounts only.** You need a WhatsApp Business Account (WABA)
with a number Meta has verified. A personal WhatsApp account cannot be connected —
not as a policy we apply on top, but because the Cloud API this integration is
built on has no concept of one.

1. Create an app at [developers.facebook.com](https://developers.facebook.com/apps)
   and add the **WhatsApp** product.
2. **WhatsApp → API Setup** → copy the **WhatsApp Business Account ID** and, just
   below it, the **Phone number ID** of your business number.
3. Create a **System User token** with **both** `whatsapp_business_messaging`
   (to send) and `whatsapp_business_management` (so we can check the account).
4. **App Settings → Basic** → copy the **App Secret**.
5. In BlissWork: **Connected accounts → WhatsApp → Connect**, paste all four.
6. The connection shows a **webhook URL** and a **verify token** — we generate the
   verify token because a hand-picked one is reliably weak.
7. In Meta: **WhatsApp → Configuration → Webhook → Edit**, paste both, subscribe
   to the `messages` field. Saving it is the last step.

> **What we check, and why you might be rejected.** Having Cloud API credentials
> proves a number exists, not that a business does — an unverified number or one
> still in Meta's test state would otherwise connect exactly like a fully
> onboarded one, and only fail later. Before storing anything we ask Meta four
> things, and refuse if any of them disagrees:
>
> | Rejected when | What to do |
> |---|---|
> | The Business Account isn't **approved** by Meta | Finish Meta's business review |
> | The number hasn't completed **verification** | Verify the number in Meta |
> | It's an **on-premise** number, not Cloud API | Only Cloud API numbers work here |
> | The number isn't **on that Business Account** | Check you copied both IDs from the same account |
>
> If your token is missing `whatsapp_business_management` we say so explicitly
> rather than blaming the credentials — that one catches almost everybody first
> time, because sending needs only the *messaging* permission.

> **Why the connection starts as Pending.** The checks above prove the account is
> real; nothing about a credential can prove Meta can reach *you*. So the
> connection stays **Pending** until Meta's own webhook verification request
> arrives — which happens the instant you save the webhook URL in step 7. That
> request is the confirmation; there is nothing to type, and BlissWork updates
> itself when it lands. A pending connection is invisible to the forwarding path,
> so nothing is silently dropped into a dead integration.
>
> Re-pasting credentials later does **not** un-confirm a working connection: your
> webhook URL is unchanged, so what that handshake proved is still true.

> **Mentions on WhatsApp are opt-in.** The Cloud API exposes no mention markup at
> all, so there is nothing to detect. A connection can opt in to treating any
> inbound 1:1 message as tagging the number's owner; otherwise WhatsApp produces
> no mentions.

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
| WhatsApp verify token | Encrypted at rest; readable by its own workspace, because the admin has to paste it into Meta and can't re-derive it. |
| WhatsApp Business Account ID, Phone number ID | Encrypted at rest, like every other connection field. Neither is secret; both are needed to re-check the account. |

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
