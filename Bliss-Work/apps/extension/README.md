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

The shipped **default** — what a managed fleet records out of the box:

| Recorded | Not recorded |
|---|---|
| Registrable domain (`github.com`) — plaintext, because every rollup groups by it | Health, banking, government, legal-aid and job-hunting sites |
| **Full URL including the query string** (`/watch?v=…`, `/search?q=…`) — encrypted per-org, read one row at a time | **Incognito / private windows** |
| How long the tab was frontmost | Page titles, page contents, form data, cookies |

The query string is kept — it is where "what they did" lives (the video, the
search terms) — but only for the sites that are recorded at all. Because a query
string can also carry session tokens and reset links, that half is stored
encrypted per-org server-side and is never aggregated; only the bare domain is
held in the clear.

### Capture scope is safe by default, per-device to widen

`src/tracker.ts` keeps a `NEVER_RECORD` category floor (health, banking,
government, legal aid, job hunting) and an incognito skip, and both are **on by
default** (`captureAll` / `captureIncognito` are off unless explicitly set). Two
properties are deliberate:

- **These flags are per-device and NOT policy-controllable.** They are absent from
  `managed-schema.json`, so no MDM policy can drop the floor or start recording
  incognito across a fleet. Widening capture is a hands-on change to one device's
  `chrome.storage.local`, not a switch an admin flips for everyone.
- **The floor is retained as code, not deleted**, so a workspace can be dialled
  either way. An org's own `blocked` list is always honoured on top.

> ⚠️ Turning `captureAll` on records employees' health, banking, government and
> legal browsing; `captureIncognito` records their private windows. That is the
> highest-liability configuration there is and, in most jurisdictions, unlawful
> without explicit disclosure and a lawful basis that a terms clause alone does not
> clear. The default keeps those protections on; overriding them is the operator's
> legal responsibility.

The rules live in `src/tracker.ts`, free of every `chrome.*` API so they can be
unit-tested — see `src/tracker.test.ts`, which pins the protected default, the
aggressive opt-in, and the always-honoured org blocklist.

## Permissions, and why each one

| Permission | Why |
|---|---|
| `tabs` | Read the active tab's URL. |
| `storage` | The pairing code + admin-provisioned enrolment (`local` / `managed`) and the pending batch (`session`). |
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

### Fastest path that actually produces data: self-hosted CRX + force-install

The store route can reject a browsing reporter and takes weeks, and store
publishing here is currently blocked on the GitHub billing issue anyway. Skip it:
build a signed CRX, host it, and force-install by enterprise policy, provisioning
each member's ingest token through managed storage so browsers enrol without
anyone pasting a code.

**The full runbook and the policy templates are in [`deploy/`](deploy/README.md)**
— `scripts/pack-crx.sh`, `deploy/chrome-policy.json`, `deploy/windows-forcelist.reg`,
`deploy/updates.xml.tmpl`, and `managed-schema.json`.

Two boundaries that are baked into those templates, not left to discipline:

- The managed policy provisions the **token, API base, and org opt-out list only**.
  It cannot set `captureAll` / `captureIncognito` — comprehensive capture of
  protected categories and private windows is not something a fleet policy can
  switch on. Those stay off unless changed by hand on an individual device.
- The templates set **no incognito allowance** and nothing that hides the "Installed
  by your organization" banner. It is disclosed and detectable.

Edge Add-ons accepts the same package under a similar review. Firefox needs a
separate AMO submission; the code is MV3-compatible but untested there.
