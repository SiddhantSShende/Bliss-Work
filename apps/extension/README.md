# BlissWork Activity — browser extension

Adds the sites a member uses to their BlissWork activity record. Manifest V3,
no framework, ~6 KB built.

```bash
npm run build -w @taskboard/extension   # → apps/extension/dist
```

Load `apps/extension/dist` via `chrome://extensions` → Developer mode → Load
unpacked. Works in Chrome, Edge and any Chromium browser at 116+.

## How it authenticates

**It never receives a JWT or a refresh token.** An extension has no secure
storage and cannot perform the SameSite-cookie refresh dance, so a session
handed to one would be a session anyone who compromised it could keep.

Instead the member mints a single-purpose code from their own signed-in session
(BlissWork → Settings → Your activity → Connect a browser extension) and pastes
it into the options page. Server-side it is stored only as `sha256(raw)`, scoped
to exactly one `(org, user)`, and it can write that person's activity and
nothing else — it cannot read anything at all. It is revocable from the same
screen that minted it, which matters because a browser on a machine that has
been wiped cannot revoke itself.

The options page **verifies the code before storing it**. Saving an unverified
code would leave the extension looking connected while silently 401ing on every
batch — recording nothing and reporting success.

## What it records

| Recorded | Not recorded |
|---|---|
| Registrable domain (`github.com`) — plaintext, because every rollup groups by it | Anything after `?` — search terms, session tokens, reset links, document ids |
| Path (`/acme/repo/pull/42`) — encrypted per-org, read one row at a time | Page titles |
| How long the tab was frontmost | Page contents, form data, cookies |
| | **Anything at all from incognito windows** |
| | Health, banking, government, legal-aid and job-hunting sites |

The exclusions are a floor, not a setting: they are enforced in `src/tracker.ts`
and cannot be configured off. An organisation can add to the list, never subtract
from it. Recording a colleague's visits to a hospital, a bank or a job board is
not workplace monitoring, and a tool that does it is a retaliation tool.

`src/tracker.ts` is deliberately free of every `chrome.*` API so those rules can
be unit-tested — see `src/tracker.test.ts`, which is the most important test file
in the feature.

## Permissions, and why each one

| Permission | Why |
|---|---|
| `tabs` | Read the active tab's URL. |
| `storage` | The pairing code (`local`) and the pending batch (`session`). |
| `alarms` | MV3 kills an idle service worker; `setInterval` does not survive that and `alarms` does. |
| `idle` | Stop accruing time when the machine is locked or idle. |

**No `host_permissions` and no content scripts.** `chrome.tabs` alone gives the
URL, and a content script would mean injecting code into every page the person
visits — a large attack surface bought for nothing.

## Distribution

Chrome Web Store review of an extension that reports browsing activity to a
third-party server is the highest-friction item in this feature and the one
whose timing you do not control: mandatory privacy-policy URL, Limited Use
disclosure, per-permission justification, and prominent-disclosure plus
affirmative-consent obligations for web history under the CWS User Data policy.
Expect weeks, and a real possibility of rejection.

The realistic path for an internal tool is **unlisted + enterprise force-install**:
publish unlisted (still reviewed, not publicly discoverable) and deploy through
the customer's MDM or Group Policy with `ExtensionInstallForcelist`. That is how
commercial products in this space actually ship, and it also answers "how do we
get 200 people to install it".

Edge Add-ons accepts the same package under a similar review. Firefox needs a
separate AMO submission; the code is MV3-compatible but untested there.
