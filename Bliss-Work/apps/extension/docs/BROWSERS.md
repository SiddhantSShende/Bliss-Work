# Browser support — architecture, packaging, and honest test status

What is shared, what is isolated per browser, and — separately, and just as
importantly — what has actually been run and what has not.

---

## 1. The contract every browser target satisfies

One activity model, regardless of browser: a `site.visit` row shaped exactly
like [`toAgentEvent`](../src/tracker.ts) produces, posted to the same
`POST /telemetry/ingest/agent` endpoint every other activity producer (the
desktop sensor, the web beacon) already uses. `detail.browser` names which
browser sent the row as a plain string the backend never branches on — see
`services/telemetry-svc/app/activity_detail.py`'s `KNOWN_BROWSERS`, which is
documentation, not an enforced allow-list, and `sessionizer.py`, which
correlates a `site.visit` row against a desktop `app.focus` row without ever
asking which browser produced it. **No backend change was needed to support
any of the browsers below** — this is what "do not force browser-specific
assumptions into the backend" looks like when it is actually true, not just
declared: the browser identity is metadata on an already-generic row, never a
condition the write path or the sessionizer inspects.

## 2. What is shared vs. isolated

| Layer | Shared across every target? | Where |
|---|---|---|
| Capture rules (what counts as a visit, the sensitive-category floor, the aggressive-mode gate, incognito handling) | **Yes — byte-identical** | `src/tracker.ts` |
| Site enrichment (YouTube/GitHub/Docs → `siteKind`/`siteRef`) | **Yes — byte-identical** | `src/siteEnrichment.ts` |
| Tab/window/idle/alarm event wiring, storage, batching, flush/retry | **Yes — byte-identical** | `src/background.ts` |
| Options page | **Yes — byte-identical** | `src/options.ts` |
| Browser identity string (`detail.browser`) | Per target, ONE literal | injected at build time, see §3 |
| Manifest (background registration, permissions, store metadata) | Per target | `manifest.json` (Chromium) / `manifest.firefox.json` (Firefox) |
| Extension runtime/packaging | Per target | esbuild bundle (Chromium, Firefox) vs. a native Xcode wrapper (Safari — see §6) |

`src/tracker.ts` and `src/siteEnrichment.ts` have zero `chrome.*`/`browser.*`
calls — this was already true before this document existed, and it is what
makes "shared logic" a verifiable fact rather than a description: those two
files are pure functions, unit-tested without any browser runtime at all (see
`src/tracker.test.ts`, `src/siteEnrichment.test.ts`).

`src/background.ts` and `src/options.ts` DO call browser APIs, and still need
no per-browser branching, because every API they call — `chrome.tabs`,
`chrome.windows`, `chrome.storage.{local,session,managed}`, `chrome.idle`,
`chrome.alarms`, `chrome.action`, `chrome.runtime` — is available, under the
SAME `chrome.*` names, on every WebExtensions-based target this repo builds
for. This is not an assumption; see §4's per-API table for Firefox
specifically.

## 3. How a browser build is produced

```bash
npm run build          -w @taskboard/extension   # Chromium -> dist/
npm run build:firefox  -w @taskboard/extension   # Firefox  -> dist-firefox/
```

`build.mjs` takes a `--target`, and the ONLY thing that differs between
targets is:

1. **Which manifest is copied** into the output (`manifest.json` vs.
   `manifest.firefox.json` — see §4, §5 for what's actually different in
   each).
2. **One literal string** (`chrome` / `firefox`) substituted into the bundle
   at `__BROWSER__` via esbuild's `define` — never a runtime `navigator`
   sniff, which drifts (a new Chromium fork ships, a UA string reformats) in
   a way a build-time constant cannot. `build.test.ts` proves this
   mechanically: it runs the real build for both targets and asserts the two
   output bundles are byte-identical except for that one substitution — not
   asserted by inspection, verified by diffing the actual artifact.
3. **Whether `managed-schema.json` is copied** (Chromium only — see §4).

## 4. Chrome / Edge / Brave — one target, shared identically

Edge and Brave are Chromium, at MV3, at the same `chrome116`+ baseline this
extension already targeted before this document existed. They are not
"supported via compatibility" — they load `dist/manifest.json` and
`dist/background.js` completely unmodified, the same files Chrome loads. The
`chromium` build target exists because these three browsers share ONE
extension platform, not because they need three near-identical manifests.

- **Packaging**: same CRX (`scripts/pack-crx.sh`), same enterprise
  force-install path documented in [`deploy/`](../deploy/README.md).
  `deploy/chrome-policy.json`'s comment already says "Chrome/Edge enterprise
  policy" — Brave also honours Chromium's `ExtensionInstallForcelist` policy
  the same way, though this repo's deploy docs have not been extended to name
  it explicitly.
- **Store distribution**: Chrome Web Store and Edge Add-ons both accept this
  exact package; Brave has no separate extension store — it installs from the
  Chrome Web Store directly.
- **What differs from Firefox**: `chrome.storage.managed` provisioning (an
  OS-level policy/registry mechanism, `managed-schema.json` declares its
  shape to Chrome) and `background.service_worker` as the MV3 background
  registration key.

## 5. Firefox — same source, different manifest, verified as far as this
environment allows

**Firefox needs NO `browser.*` shim and NO polyfill.** This was the single
biggest architectural question going in, and it resolved in the simple
direction: Firefox has supported `chrome.*` as a compatibility namespace for
years, and current Firefox additionally makes `chrome.*` calls
Promise-based (not only callback-based) under MV3 — the exact calling
convention this codebase already uses everywhere (`await chrome.tabs.get(...)`,
etc.). Mozilla's own `webextension-polyfill` package — the historical
standard answer to "one codebase, both browsers" — is now archived
end-of-life for the opposite reason: Chrome itself is adopting the `browser`
namespace, so the compatibility gap the polyfill existed to paper over is
closing from both directions. Pulling in an EOL package to solve an
already-closed gap would have been the second mistake, after not researching
whether the gap was closed at all.

### 5.1 What differs — isolated entirely to the manifest

| | Chromium (`manifest.json`) | Firefox (`manifest.firefox.json`) |
|---|---|---|
| Background registration | `background.service_worker` | `background.scripts` (Firefox runs an event page, not a Chrome-style service worker — see Firefox bug 1573659; MDN documents `service_worker` as unsupported) |
| Extension identity | Chrome Web Store assigns an ID on publish | `browser_specific_settings.gecko.id` is declared in the manifest — **the placeholder `activity@blisswork.example` in this repo must be replaced with a real id before any AMO submission** |
| Minimum version | `minimum_chrome_version: "116"` | `browser_specific_settings.gecko.strict_min_version: "115.0"` |
| Managed-storage schema | `storage.managed_schema` (Chrome-specific key; omitted entirely from the Firefox manifest — see below) | none in the manifest; Firefox provisions `chrome.storage.managed` via a native-manifest JSON file or the `3rdparty` enterprise policy, a different mechanism this repo's `managed-schema.json`/`deploy/chrome-policy.json` do not cover yet |

### 5.2 Per-API confirmation (not assumed — checked against Firefox's own
compatibility data)

| API this extension calls | Firefox support |
|---|---|
| `tabs.onActivated`, `tabs.onUpdated`, `tabs.get`, `tabs.query` | Yes, long-standing |
| `windows.onFocusChanged`, `windows.WINDOW_ID_NONE` | Yes, long-standing |
| `storage.local`, `storage.managed` | Yes — `storage.managed` provisioning mechanism differs, see §5.1 |
| `storage.session` | Yes, **Firefox 115+** — this is the newest API this build depends on and sets the manifest's `strict_min_version` floor |
| `idle.setDetectionInterval`, `idle.onStateChanged` | Yes, Firefox 51+ |
| `alarms.create`, `alarms.onAlarm` | Yes, Firefox 45+ |
| `action.setBadgeText` | Yes, Firefox 109+ (the `action` namespace itself, replacing MV2's `browserAction`) |

### 5.3 What was actually verified, and what was not

**Verified, in this environment:**
- `npm run build:firefox` runs esbuild against the real source and produces a
  real `dist-firefox/` bundle + manifest.
- `build.test.ts` asserts the Firefox manifest has `background.scripts`
  (not `service_worker`), the `browser_specific_settings.gecko` block, no
  `storage.managed_schema` key, and that the bundled JS is byte-identical to
  the Chromium bundle except for the one `__BROWSER__` literal.
- Every API-support claim in §5.2 is sourced from Mozilla's own published
  compatibility data (MDN / `browser-compat-data`), not memory or inference.
- `tracker.ts`/`siteEnrichment.ts`'s existing test suites (which this Firefox
  work did not touch) continue to pass unmodified — the shared logic really
  is shared, not coincidentally similar.

**NOT verified — no Firefox binary was available in this environment:**
- The bundle has never actually been loaded into Firefox (`about:debugging`
  → Load Temporary Add-on, or a signed AMO submission).
- Firefox's real background-event-page lifecycle (how aggressively it
  unloads an idle background script) was not independently confirmed — MDN
  does not publish a precise number the way Chrome documents ~30s for
  service workers, and this repo's existing "never trust in-memory state,
  always re-read from `chrome.storage.session`" design (already true before
  this task, written for Chrome's service-worker teardown) is assumed to
  cover Firefox's event-page teardown too, on the reasoning that it is *at
  least as* defensive as whatever Firefox's real behaviour turns out to be —
  but that reasoning has not been tested against the real browser.
- AMO's actual validator (`web-ext lint` / addons-linter) has not been run
  against `manifest.firefox.json`. The manifest keys used are confirmed
  correct against Mozilla's schema documentation, not against a real lint
  pass.
- The placeholder `browser_specific_settings.gecko.id` has never been
  replaced with a real identity or submitted for signing.

**Required before shipping to Firefox users:** load the real
`dist-firefox/` build in an actual Firefox profile, run `web-ext lint`
against it, and exercise the full BlissWork → other-site → BlissWork
sequence with real tab switches — the same bar the Chromium extension
already cleared before it shipped.

## 6. Safari — a genuinely distinct implementation concern

Safari is not a fourth manifest variant. It cannot be, for reasons Apple
enforces at the platform level, not reasons of convenience:

- **Safari does not load a raw WebExtension bundle.** It requires a native
  macOS (or iOS) **application wrapper**, built and code-signed via Xcode,
  with the web extension embedded as an app extension inside it. The
  standard path is Apple's own `safari-web-extension-converter` CLI, which
  takes a Chrome-style extension folder as INPUT and generates an Xcode
  project — meaning this repo's `dist/` (the Chromium build) is the correct
  starting artifact to feed it, but the conversion, build, signing, and
  notarization steps happen entirely outside esbuild/`build.mjs`, in Xcode
  and `xcodebuild`.
- **Distribution requires an Apple Developer Program membership** and, for
  broad distribution, submission through the macOS App Store (Safari
  extensions are not sideloadable the way an unpacked Chrome extension is,
  outside of Safari's own limited developer/unsigned-extension debug mode) —
  a real cost and review process this repo's existing "self-hosted CRX,
  skip the store" strategy (see [`deploy/README.md`](../deploy/README.md))
  has no equivalent escape hatch for.
- **Safari-specific permission model**: Safari Web Extensions request
  per-site or all-sites access through Safari's own permission UI, distinct
  from Chrome's `host_permissions` prompt flow — though this extension
  declares `host_permissions: []` already (it only reads `chrome.tabs`, never
  injects into pages), which should mean there is no per-site grant to
  request in the first place; this has not been confirmed against Safari's
  actual permission prompt behavior for a `tabs`-only extension.
- **App sandboxing and entitlements**: the wrapper app runs under macOS App
  Sandbox by default, which affects network access (`fetch` to
  `POST /telemetry/ingest/agent` needs the `com.apple.security.network.client`
  entitlement — the SAME entitlement `apps/desktop/build/entitlements.mac.plist`
  already declares for the Electron app, for the same reason) and the
  extension's storage APIs, neither of which is guaranteed to behave
  identically to Chrome's implementation of `chrome.storage.*` underneath.

### 6.1 What this task actually did for Safari

Given no macOS/Xcode environment was available here (confirmed unavailable
in the prior desktop-sensor task, and unchanged for this one): the
architectural SEAM is in place — `tracker.ts`/`siteEnrichment.ts` need no
Safari-specific code at all (they are already browser-free), and
`background.ts`'s `__BROWSER__` injection point is exactly where a Safari
build would plug in `"safari"` as its literal, the same mechanism Firefox
uses. What this task did NOT do, and is not claiming to have done, is:

- Run `safari-web-extension-converter` against this repo's `dist/` output.
- Produce, build, or sign an Xcode project.
- Verify `chrome.tabs`/`chrome.storage`/`chrome.idle`/`chrome.alarms`
  actually behave the same way inside Safari's WebExtension implementation
  as they do in Chromium/Firefox — Safari's API coverage has historically
  lagged and had behavioral differences (e.g., `chrome.alarms` minimum
  interval enforcement, `storage.session` availability) that were not
  independently checked against Safari's current WebKit release notes for
  this task.
- Confirm the App Sandbox network entitlement actually permits the
  extension's `fetch` calls to reach an external API in practice, as opposed
  to reasoning by analogy to the Electron app's own entitlement.

**Required before Safari can be called supported:** a real macOS machine with
Xcode, a run of `safari-web-extension-converter` against `dist/`, a signed
(at minimum ad-hoc, ideally Developer ID) build loaded in Safari, and the
same BlissWork → other-site → BlissWork verification pass every other target
needs — none of which this environment could perform. Claiming Safari
"supports the architecture" on the strength of `tracker.ts` being
browser-free would be exactly the kind of claim this feature's own
requirements warn against; this document says so explicitly rather than
leaving it to be inferred from an unqualified checkmark somewhere else.

## 7. Graceful degradation — what happens when the extension is not there,
not enabled, or not permitted

This is a property of the EXISTING architecture (`sessionizer.py`,
`activity-agent.ts`), not something newly added for multi-browser support —
restated here because it is what makes shipping Firefox/Edge/Brave (and
eventually Safari) low-risk rather than a new failure mode per browser:

| Scenario | What happens |
|---|---|
| Extension not installed at all | The desktop sensor still reports "Switched to Chrome"/"Switched to Firefox" (app-level, from `activityDestination.ts`'s `BROWSER_NAMES`/`browserSlug`) with no page-level detail. `sessionizer.py`'s `_sessionize_desktop` produces a standalone `kind: "app"` session — proven by `tests/integration/test_sessionizer.py`'s "desktop-only" test, unrelated to which browser is involved. |
| Extension installed but disabled/paused | `background.ts`'s `focus()` checks `cfg.token && !cfg.paused` before recording anything — a paused extension behaves identically to an uninstalled one from the backend's perspective: no `site.visit` rows, desktop-only coverage continues. |
| Browser does not expose a requested capability | Every capability this extension uses is checked defensively at the point of use — `chrome.storage.managed.get()` is wrapped in try/catch (`config()`, treats a throw as "unmanaged browser"), `chrome.runtime.sendMessage` in `notifyWorker()` is wrapped in try/catch (treats a throw as "worker asleep, it'll re-read on wake"). No capability this extension depends on is assumed present without a fallback. |
| Browser permission denied (e.g., a user declines to grant `tabs`) | `chrome.tabs.get`/`chrome.tabs.query` would throw or return undefined; every call site (`tabs.onActivated`, `tabs.onUpdated`, `windows.onFocusChanged`) already wraps its tab lookup in try/catch, treating a failure as "the tab closed between the event and the lookup" — the SAME code path degrades a permission failure identically to any other transient failure, closing whatever span was open rather than crashing the worker. |
| The BACKEND's perspective on any of the above | Never distinguishes "no browser signal because uninstalled" from "no browser signal because Firefox isn't supported yet" from "no browser signal because permission was denied" — all three look identical: no `site.visit` rows for that time window, desktop-only (or fully absent) coverage. This is deliberate: the backend does not need to know WHY browser data is missing to degrade correctly, only THAT it is missing, which `sessionizer.py`'s standalone-session path already handles for any reason at all. |
