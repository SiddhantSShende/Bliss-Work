# Becoming a Meta Tech Provider (WhatsApp one-click signup)

This is what **BlissWork** has to obtain from Meta before customers can connect
WhatsApp in one click. It is not something a customer does, and it is not
something code can substitute for — until it is done, the
**Connect WhatsApp Business** button reports itself unavailable and everyone
falls back to the advanced/manual flow in `INTEGRATIONS-SETUP.md`.

## Why it's needed

Embedded Signup lets a customer authorize us against *their* WhatsApp Business
Account from a Meta-hosted popup — no developer app, no tokens, no IDs on their
side. That only works when Meta has approved **our** app to act on other
businesses' behalf. Everything below is Meta's approval process, not ours, and
the review portion takes weeks. Start it early.

## Steps, in order

1. **Create the Meta app** at [developers.facebook.com](https://developers.facebook.com/apps)
   — type *Business*. This is the one and only BlissWork app; it is not per
   customer and not per deployment environment.
2. **Add the WhatsApp product** to it, and **Facebook Login for Business**.
3. **Complete Meta Business verification** for the BlissWork business portfolio
   (legal entity documents, address, phone). Nothing below is grantable until
   this passes.
4. **Request Advanced Access** for both permissions, under App Review:
   - `whatsapp_business_management` — read the customer's Business Account, and
     subscribe our app to its webhooks.
   - `whatsapp_business_messaging` — send and receive on their number.
   Standard Access is not enough: it only ever works against businesses you own.
5. **Create the Embedded Signup configuration** (WhatsApp → Embedded Signup) and
   copy its **configuration ID**.
6. **Configure the app-level webhook** — Meta delivers *every* customer's
   messages to this one URL, because Embedded Signup subscribes our app rather
   than a per-connection URL:
   - Callback URL: `https://<public-base-url>/ext/whatsapp/webhook`
   - Verify token: whatever you set as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the `messages` field.
7. **Set the environment variables** in `.env.prod` and redeploy:

   | Variable | Where it comes from |
   |---|---|
   | `META_APP_ID` | App dashboard → App ID |
   | `META_APP_SECRET` | App dashboard → App Secret |
   | `META_CONFIG_ID` | The Embedded Signup configuration ID from step 5 |
   | `WHATSAPP_VERIFY_TOKEN` | Your choice; must match step 6 |
   | `WHATSAPP_APP_SECRET` | Same value as `META_APP_SECRET` (used to verify webhook signatures). `META_APP_SECRET` falls back to this if unset, so setting one is enough. |

   The feature turns itself on when `META_APP_ID`, `META_CONFIG_ID` and a secret
   are all present — `GET /api/v1/integrations/whatsapp/embedded` starts
   answering `available: true` and the button enables itself. No code change.

8. **Add the app domain and redirect** for the popup page:
   `https://<web-origin>/whatsapp-connect.html` must be reachable and its origin
   listed in the app's allowed domains.

## Verifying it works

Connect one real WhatsApp Business Account end to end. In order, the things that
can fail and what they look like:

| Symptom | Cause |
|---|---|
| Button still disabled | One of the three env vars is unset, or the service wasn't restarted |
| Popup opens then closes with an error | App not approved for Advanced Access, or the config ID is from a different app |
| "BlissWork's WhatsApp app isn't permitted…" | Advanced Access missing for `whatsapp_business_management` |
| Connects, but no messages arrive | App-level webhook (step 6) not configured, or `messages` not subscribed |
| Connects, but sending fails | The number wasn't registered — check the `/register` call in the logs |

## Notes

- **The app secret is deployment-wide and sensitive.** It verifies the signature
  on every customer's inbound webhook; leaking it lets anyone forge inbound
  messages for every workspace at once. It is never sent to a browser — only
  `META_APP_ID` and `META_CONFIG_ID` are, and those travel in the popup URL by
  design.
- **One phone number, one workspace.** Migration `0010` enforces this globally,
  because with a single app-level webhook the receiver resolves deliveries by
  phone number id alone; two workspaces claiming one number would misroute
  messages between them.
- **Keep the manual flow.** It is the fallback if Meta approval lapses, and the
  escape hatch for an account Embedded Signup can't handle.
