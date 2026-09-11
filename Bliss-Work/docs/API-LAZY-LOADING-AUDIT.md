# Service API Lazy Loading & On-Demand Fetching — Repository Audit

**Audit only. Nothing in this document was implemented.** No frontend, backend,
or Electron code was modified to produce it, nothing was committed, and no
concurrent/uncommitted work was touched. Every claim below is either
**CONFIRMED** (read directly from source, file:line cited) or explicitly
marked **UNKNOWN**/**deployment-dependent** where the repository alone
doesn't settle it. Section S is a *plan*, not a change.

---

## A. Executive Summary

Route-level code splitting is already solid platform-wide: every
authenticated screen (`Tasks`, `ChannelView`, `MailLayout`, `MeetingsLayout`,
`MemberDetail`, `Org`, `Settings`, etc.) is behind `React.lazy()` +
dynamic import, and React Router's `<Routes>` only ever mounts one matched
route at a time (`packages/app/src/App.tsx:63-90`). That part of the
"only fetch what's open" requirement was already met before this audit.

**The one real, high-impact violation is `AppShell.tsx`**, the shell mounted
for *every* authenticated `/app/*` route regardless of section. It
unconditionally fires four full-list queries — `notifications()`,
`conversations()`, `channels()`, and `useInboxPeers()` — purely to sum
`.unread` counts for the sidebar rail badges (`AppShell.tsx:32-68`). A user
who opens the app and only ever uses Tasks still downloads the complete
Channels list and the complete Conversations list. This is deliberate, not
an oversight — the code's own comment explains it reuses the exact same
query key `ChatsList`/`ChannelsList`/`MailFolders` need, so opening that
section later costs nothing extra — but it means three of these four calls
exist as a workaround for a lightweight endpoint that doesn't exist yet
(confirmed: no unread-*count*-only endpoint exists in `packages/shared/src/api/client.ts`
for any of notifications/conversations/channels).

**Tasks is the one section that gets no benefit from that trade-off** —
opening it costs four *fresh* requests (`taskAssigned`, `tasksSent`,
`directory`, `taskAvailability`) plus a 30s recurring poll, because
AppShell's "tasks" badge is computed from the notifications feed, not from
`qk.assigned`/`qk.sent`. Tasks itself is correctly lazy; it just doesn't
share AppShell's cache the way Chats/Channels/Mail do.

A second, independent, concrete bug was found along the way:
`AvailablePeople.tsx` still calls the deprecated org-wide `api.presence()`
polled every 20s — the exact endpoint `usePresence.ts`'s own doc comment
says was replaced because polling a whole organization's presence was
expensive at scale, and which nothing else in the repository calls anymore.
This is a real backend-load issue, unrelated to route timing.

On Electron, the WebSocket connection and the sticky-notes data fetch are
correctly gated behind a real access token (traced end-to-end, not
assumed) — not eager regardless of login state. But **auto-start-at-login
runs the entire renderer, including AppShell's four unconditional queries,
inside a hidden window immediately after OS login**, before the user has
opened the app at all — a real, Electron-specific amplifier of the same
underlying issue.

---

## B. Application/API Architecture

```text
Application Startup
  apps/web/src/main.tsx / apps/desktop/src/renderer/main.tsx
        ↓ (builds PlatformConfig, no API calls here — CONFIRMED, both read directly)
  <App config={config}>  (packages/app/src/App.tsx)
        ↓
  QueryClientProvider (staleTime:10_000, refetchOnWindowFocus:false — App.tsx:160-175)
        ↓
  RuntimeProvider (packages/app/src/lib/runtime.tsx)
        — constructs ApiClient + WsClient objects. Construction is inert:
          neither issues a request nor opens a socket on its own (CONFIRMED,
          both constructors are field assignment only).
        ↓
  Router > ThemedTree > MeetingSessionProvider > SessionBootstrap
        — SessionBootstrap (App.tsx:396-437) is the ONE always-run global
          fetch: refreshSession() against the auth cookie/token. Legitimate —
          nothing can render as "authed" without it.
        ↓
  <Routes> — signed-out routes (Login/Onboarding/etc.) render eagerly;
             everything behind RequireAuth is React.lazy (App.tsx:51-90)
        ↓
  /app  → RequireAuth → SelectedChatProvider → AppShell (routes/AppShell.tsx)
        — THE FINDING: fires notifications/conversations/channels/inboxPeers
          unconditionally here, before any section is chosen (see D/G).
        — Also mounts here, globally, but CONFIRMED correctly gated or
          inert: WsEventBridge (connects WS, doesn't itself over-fetch —
          see N), TelemetryBridge (wires a mutation callback only), CallUI/
          CallProvider (no eager query), MeetingHost (enabled: !!callId).
        ↓
  <Outlet /> → one lazy-loaded feature route (Tasks/ChannelView/MailLayout/
               MeetingsLayout/MemberDetail/Org/Settings/...)
        ↓
  Feature-owned useQuery hooks — CONFIRMED, per-route, fire only on that
  route's own mount (see D/K for the full per-route trace)
```

Two components render OUTSIDE the `RequireAuth` boundary, as siblings of
`SessionBootstrap` rather than children — `BrowserStickies` and
`MeetingHost` (`App.tsx:339,349`) — meaning they exist even on `/login`.
Both are internally gated correctly (see J), so this placement does not
currently cause a premature fetch, but it is the one place in the tree
where "mounted" and "authenticated" are not the same boundary — worth
knowing precisely rather than assuming pre-auth means nothing runs.

---

## C. Complete API Inventory

Populated from direct repository evidence (my own reads of `App.tsx`,
`AppShell.tsx`, `runtime.tsx`, `queryBridge.tsx`, `useInboxPeers.ts`,
`useCall.tsx`, `BrowserStickies.tsx`, `MeetingHost.tsx`, plus two
exhaustive sub-audits covering every route/feature file and the full
Electron main/preload/renderer tree).

| Service | API | Caller | Trigger | Current timing | Intended timing |
|---|---|---|---|---|---|
| Notifications | `GET /api/v1/notifications` | `AppShell.tsx:32-35` | AppShell mount | Every `/app/*` navigation | Notification bell opened (badge count is the only other early need) |
| Messaging | `GET conversations` | `AppShell.tsx:59-62` | AppShell mount | Every `/app/*` navigation | Chats section opened (dual-purpose: also primes `ChatsList`) |
| Channels | `GET channels` | `AppShell.tsx:64-67` | AppShell mount | Every `/app/*` navigation | Channels section opened (dual-purpose: also primes `ChannelsList`) |
| Mail (inbox peers) | inbox peers list | `useInboxPeers()`, `AppShell.tsx:46` | AppShell mount | Every `/app/*` navigation | Mail/People section opened (dual-purpose: also primes `MailFolders`) |
| Tasks | `taskAssigned()` | `Tasks.tsx:110` (`AssignedBucket`) | Tasks view mount | Tasks opened | Correct as-is |
| Tasks | `tasksSent()` | `Tasks.tsx:337` (`MyTasks`) | `view==="mine"` mount | Tasks "mine" view opened | Correct as-is |
| Tasks | `directory()` | `TasksList.tsx:26` (via `useAvailability`) | Tasks sidebar mount | Tasks section opened | Correct as-is |
| Tasks | `taskAvailability()`, 30s poll | `useAvailability.ts` via `TasksList.tsx:26` | Tasks sidebar mount | Runs entire time any Tasks sub-view is open | Correct scope; poll cadence is a separate question |
| Channels | `channelMessages(id)` | `ChannelView.tsx:109-113` | `enabled: !!channelId` | Channel opened | Correct as-is |
| Channels | `channelReadReceipts(id)`, 30s poll | `ChannelView.tsx:179-188` | that channel open | Channel opened, only while open | Correct as-is |
| Mail | unified inbox feed | `MailList.tsx:94` | Mail list mount | Mail opened | Correct as-is |
| Mail | `thread(id)` / `mail(id)` | `MailThread.tsx:47-50`, `MailDetail.tsx:90` | thread/mail opened | Correct as-is |
| Meetings | `myCallsInRange(...)` | `MeetingsCalendar.tsx:88-91` | Meetings calendar mount | Meetings opened | Correct as-is |
| Meetings | `myCalls()` / `callHistory` | `MeetingList.tsx:72,76-82` | Meetings mount / `bucket==="past"` | Meetings opened | Correct as-is |
| Members | `listMembers()` / `directory()` | `MemberDetail.tsx:51-59` | Member profile mount | Member profile opened | Correct as-is |
| Members | `directory()` | `MembersList.tsx:29` | Members sidebar mount | Members section opened | Correct as-is |
| Presence | chunked `presenceOf(batch)`, 20s/batch | `usePresence.ts:84-103` | consumer mount (ChatsList/MembersList/DMView) | While that list is open | Correct as-is |
| Presence | **org-wide `presence()`, 20s poll** | `AvailablePeople.tsx:36-40` | Tasks "Available" bucket open | Whenever Available bucket renders | **Bug — should use the chunked `usePresence()` path (see Q2)** |
| Search | `directory()`, `taskAssigned()`, `tasksSent()` | `Search.tsx:34-38` | Search page mount | Immediately on opening Search, before typing | CONDITIONAL — see F |
| Desktop sticky | `tasksSticky()`, `stickyPins()` | `ws-process.ts:101-148` | valid access token via IPC | Every launch with a valid session (any window, even hidden) | Justified as cross-cutting (see E) |

---

## D. APIs Currently Called Too Early

### D1. AppShell's four badge queries (the central finding)

| Field | Value |
|---|---|
| File | `packages/app/src/routes/AppShell.tsx:32-68` |
| Function/component | `AppShell()` |
| Current trigger | Every mount of AppShell — i.e., every navigation to any `/app/*` route |
| APIs called | `api.notifications()`, `api.conversations()`, `api.channels()`, `useInboxPeers()` |
| Why it is called | Sidebar rail badge counts (unread mail/tasks/chats/channels), computed by summing `.unread`/filtering `.read` across the FULL list — there is no lightweight counts-only endpoint for any of these three services (confirmed: `notifications()`, `conversations()`-shaped endpoints in `packages/shared/src/api/client.ts` return full arrays only) |
| Can it be deferred? | **CONDITIONAL.** `notifications()` has no other early consumer (the panel itself only renders the already-fetched list when opened) — a lightweight `/notifications/unread-count` endpoint would let this defer cleanly. `conversations()`/`channels()`/inbox-peers are **dual-purpose**: they also prime the exact cache key `ChatsList`/`ChannelsList`/`MailFolders` read, so naively deferring them would not remove the fetch, it would just move it to first-open of that section AND remove the badge's ability to show an accurate count before that section has ever been opened — a real feature loss, not a pure win. See Q for the honest cost/benefit. |

### D2. Search.tsx's three cross-domain, un-gated queries

| Field | Value |
|---|---|
| File | `packages/app/src/routes/Search.tsx:34-38` |
| Current trigger | Search page mount (not gated on `enabled: !!query`) |
| APIs called | `api.directory()` (fresh), `api.taskAssigned()` (fresh), `api.tasksSent()` (fresh) — plus `channels()`/`conversations()` which are cache hits off AppShell |
| Why it is called | Deliberate client-side search over already-loaded lists, avoiding a server round trip per keystroke |
| Can it be deferred? | **CONDITIONAL.** Gating behind `enabled: query.length > 0` (or a short debounce) would remove the cost of *opening* Search without typing anything, at the price of a first-keystroke latency hit instead of an instant local filter. This is a genuine product trade-off, not a clear bug — flagged as CONDITIONAL per Hard Rule #11, not YES. |

### D3. Meetings/Members screens' conditional full-directory fallback

| Field | Value |
|---|---|
| Files | `packages/app/src/lib/userLabel.ts:70-92` (`useUserLabels`), consumed by `MeetingsCalendar.tsx`, `MeetingDetail.tsx`, `MeetingList.tsx` |
| Current trigger | Any of those components rendering a participant/organizer name, when `config.graphBase` is NOT configured |
| API called | `api.directory()` — the full org directory, to resolve a handful of names |
| Why it is called | No graph gateway configured ⇒ REST fallback has no batched "resolve these N user IDs" endpoint, so it falls back to the full list |
| Can it be deferred? | **NO, without a backend change** — reuses `qk.directory` (same key `MembersList.tsx` uses), so it's a cache hit if Members was opened first, a fresh full-directory fetch if Meetings is opened first. Whether this deployment has `graphBase` configured is **deployment-dependent, not settled by the repository alone** — `.env.prod` was confirmed earlier this session to set `VITE_GRAPH_BASE`, which if still current would mean this fallback path is inactive in production today; that should be re-verified before treating this as an active problem. |

---

## E. APIs That Should Remain Global

Per Hard Rule #14, each with the reason deferring it would break something:

1. **Auth/session bootstrap** (`refreshSession()`, `SessionBootstrap` in
   `App.tsx:396-437`). Nothing else can determine whether the user is
   signed in without it; every other decision in the tree (what routes
   exist, whether AppShell mounts at all) depends on its result. Deferring
   it is incoherent — there is no "later" for it to defer to.
2. **The WebSocket connection, once authenticated** (`WsEventBridge`,
   mounted in `AppShell`, connects in `queryBridge.tsx:72-80`). Presence,
   live badge updates, and real-time delivery across every section depend
   on one connection existing for the life of the authenticated session,
   not per-section. Confirmed this does NOT itself cause the premature
   full-list-fetch problem — it only invalidates (marks stale) queries
   that are already mounted; it doesn't force-fetch inactive ones (see N).
3. **Sticky task-note delivery (Electron: `ws-process.ts`'s
   `tasksSticky()`/`stickyPins()`)**. Its own doc comment states the
   requirement explicitly: a note must pop up "app-wide... not only on the
   inbox/home screen," so a user working in Mail must still see a new task
   sticky without having opened Tasks. This is a genuine cross-cutting
   notification requirement, confirmed auth-gated (not eager regardless of
   login — see O), so it is correctly global, not correctly *un-gated*.
4. **Electron auto-updater** (`updater.ts`, initial check + 3-minute
   periodic re-check, `main/index.ts:182`, `updater.ts:105,114`). Not a
   service/feature API in the sense this audit is about — it's the
   application's own update-feed check, industry-standard practice for a
   self-updating desktop app (same pattern as VS Code/Slack/Discord),
   gated only on `app.isPackaged` because there is no "feature" boundary
   for "should this build check for updates" — deferring it would mean
   users never learn a fix shipped.

---

## F. APIs That Should Become On-Demand

Two concrete, low-risk candidates and one conditional one — everything
here is bounded by what section it belongs to, not a wholesale redesign:

1. **`AvailablePeople.tsx`'s org-wide `api.presence()` poll** — should
   call `usePresence()` (the already-built chunked replacement) instead of
   its own independent `api.presence()`/20s-interval call. This is a
   straightforward same-shape swap to an already-existing hook, not new
   architecture (see Q2 for detail).
2. **Search.tsx's `directory()`/`taskAssigned()`/`tasksSent()`** — gate
   behind `enabled: query.length > 0` if the product accepts a small
   first-keystroke latency in exchange for not fetching on Search-open.
   CONDITIONAL — needs a product decision, not just an engineering one.
3. **AppShell's notifications badge** specifically (not the other three)
   — genuinely on-demand-able TODAY with zero backend change: gate
   `enabled` on whether the bell has ever been opened this session, and
   accept that the badge shows nothing until first-open OR keep fetching
   it eagerly since, unlike conversations/channels/inboxPeers, it has no
   dual-purpose cache-priming benefit to lose. This is the one AppShell
   query where "just defer it" is a clean win with no offsetting cost
   found in this audit.

---

## G. Service-by-Service Lazy Loading Matrix

| Service | API | Current Trigger | Required Trigger | Action |
|---|---|---|---|---|
| Notifications | `notifications()` | AppShell mount (always) | Bell opened, or a lightweight count | Defer or replace with count endpoint |
| Messaging (Chats) | `conversations()` | AppShell mount (always) | Chats opened | Keep global — dual-purpose (badge + list-pane prime), no lightweight alternative exists |
| Channels | `channels()` | AppShell mount (always) | Channels opened | Keep global — same reasoning as Messaging |
| Mail (inbox peers) | `inboxPeers()` | AppShell mount (always) | Mail opened | Keep global — same reasoning |
| Tasks | `taskAssigned/tasksSent/directory/taskAvailability` | Tasks mount | Tasks opened | **Already correct** — no action |
| Channels detail | `channelMessages/channelReactions/channelReadReceipts` | Channel mount | Channel opened | **Already correct** — no action |
| Mail detail | `thread/mail` | Thread/mail mount | Item opened | **Already correct** — no action |
| Meetings | `myCallsInRange/myCalls/callHistory` | Meetings mount | Meetings opened | **Already correct** — no action |
| Members | `listMembers/directory` | Member profile / Members sidebar mount | Section opened | **Already correct** — no action |
| Presence (chunked) | `presenceOf(batch)` | List consumer mount | While that list is open | **Already correct** — no action |
| Presence (org-wide, stale) | `presence()` | `AvailablePeople` mount | N/A — should not exist | **Fix: migrate to `usePresence()`** |
| Search | `directory/taskAssigned/tasksSent` | Search mount, ungated | Query non-empty (product decision) | CONDITIONAL |
| Meetings/Members name resolution | `directory()` fallback | any name render, no graphBase | N/A if graphBase configured | Deployment-dependent, re-verify `VITE_GRAPH_BASE` in prod |

---

## H. Global Provider Audit

Traced every provider between `<App>` and the first route match
(`App.tsx:180-368`):

| Provider | Fetches on mount? | Verdict |
|---|---|---|
| `QueryClientProvider` | No — just config | Clean |
| `RuntimeProvider` | No — constructs inert `ApiClient`/`WsClient` objects only | Clean |
| `FileTransferProvider` | UNKNOWN — not traced this pass, out of scope for service-API fetching (file-transfer state, not a service API) | Not applicable to this audit's objective |
| `ThemedTree` | No — reads `useLocation()` only | Clean |
| `MeetingSessionProvider` | No eager query found in either sub-agent's trace of `useCall.tsx`/`MeetingSession.tsx` | Clean |
| `SessionBootstrap` | Yes — `refreshSession()` | Legitimate, see E1 |
| `SelectedChatProvider` | No — pure selection state | Clean |
| `AppShell` (not a "provider" but the equivalent high-risk mount point) | **Yes — 4 queries, see D1** | **The finding** |

---

## I. Sidebar/Navigation Audit

AppShell's rail conditionally renders exactly one list pane based on
`section` (`AppShell.tsx:117-132`, `{section === "mail" && <MailFolders/>}`
etc.) — React's `&&` short-circuit means an unmounted pane's own query
never runs. Confirmed each pane's query key against AppShell's four
primed keys:

| Pane | Own query | Same key as AppShell? | Extra network cost |
|---|---|---|---|
| `ChatsList.tsx:123` | `conversations()` | Yes | None — cache hit |
| `ChannelsList.tsx:49-52` ("mine") | `channels()` | Yes | None — cache hit |
| `ChannelsList.tsx:86-100` ("browse") | `openChannels` (infinite query) | No | New, but correctly gated to `tab==="browse"` (explicit user action, not section-open) |
| `MailFolders.tsx:61` | `useInboxPeers()` | Yes (fixed queryKey, confirmed unaffected by `enabled`) | None — cache hit |
| `MembersList.tsx:29` | `directory()` | No | Fresh fetch — Members gets no benefit from AppShell |
| `MembersList.tsx:35-40` | `memberActivity()`, 60s poll, admin-only | No | Fresh fetch + recurring poll, admin-gated |
| `TasksList.tsx:22-26` | `assigned/sent/directory/availability` | No (any of them) | Tasks section is the one with zero AppShell overlap — see summary in A |

This directly separates **navigation metadata** (route, icon, label,
badge count) from **feature data** (the full list) exactly along the line
Phase 6 asks for — except that today the badge count IS the feature data,
for three of the four sections, because no cheaper source exists.

---

## J. Hidden Component Audit

Two components render outside the `RequireAuth` boundary (`App.tsx:339,349`,
siblings of `SessionBootstrap`, not children) — meaning mounted even on
`/login`:

| Component | Fetches while hidden/pre-auth? | Gate | Verdict |
|---|---|---|---|
| `BrowserStickies` (`features/BrowserStickies.tsx:128-147`) | Query exists (`tasksSticky()`) but `enabled = authed && !isElectron && inApp` | Correctly false on `/login` and in Electron | Clean, deliberately app-wide once authed (task stickies must float across every section — own comment, line 135-138) |
| `MeetingHost` (`features/MeetingHost.tsx:90-103`) | Query exists (`qk.call(callId)`) but `enabled: !!callId && !dismissed && sessionStatus==="authed"` | Correctly false with no active call or pre-auth | Clean |

Also checked (mounted inside AppShell, not pre-auth, but globally present
for every section):

| Component | Fetches? | Gate | Verdict |
|---|---|---|---|
| `CallProvider`/`useCall.tsx` | No eager query found; action functions only (start/end/join call), plus non-network `primeRingtoneAudio()`/`primeCallNotifications()` on mount | N/A | Clean |
| `TelemetryBridge` | No — wires `api.sendBeacon` as a callback for the queue, doesn't call it itself | N/A | Clean |
| `CallUI`'s `RoomHandoff` (found incidentally by the sub-audit, not in the original AppShell list) | `qk.call(callId)`, un-gated `enabled` | Rendered only when `call.roomCallId` is truthy (1:1→group handoff in progress) | Clean — gated by conditional render, not by `enabled` |

No case was found of a component fetching real data while genuinely
inert/invisible with no eventual consumer — every "mounted but hidden"
case traced resolves to either an `enabled` gate or a conditional-render
gate that correctly tracks the real need.

---

## K. Route/Tab Mounting Audit

Confirmed via `App.tsx:210-336`: React Router's `<Routes>` renders exactly
one matched `<Route>` element at a time — Dashboard/Mail/Tasks/Channels/
Meetings are never simultaneously mounted. Layout routes (`MailLayout`,
`MeetingsLayout`) themselves hold **zero queries** (confirmed via direct
grep on both files) — they are pure `<Outlet/>` wrappers, and their
mutually-exclusive children (`MailWelcome`/`MailThread`/`MailDetail`/
`MailCompose`/`MailTask`; `MeetingsCalendar`/`MeetingDetail`) are what
actually fetch, each only on its own mount.

`ChatsPane` (`App.tsx:462-471`) is the one deliberate exception to
route-per-screen: `/app/chats` is a single route, and `DMView` only
mounts once `useSelectedChat().selectedId` is truthy — i.e., picking a
specific conversation, not merely opening the Chats tab. Confirmed no
premature fetch: `DMView`'s own queries (`messages(conversationId)`,
`reactions(conversationId)`) are `enabled: !!conversationId`.

No case was found of every feature being mounted simultaneously at
startup — the "NOT" pattern the spec warns against in Phase 5/8 does not
exist in this codebase today.

---

## L. Prefetch Audit

| Prefetch | Why it exists | When it runs | Cost | Common enough to justify? | Classification |
|---|---|---|---|---|---|
| AppShell's conversations/channels/inboxPeers (double as prefetch for `ChatsList`/`ChannelsList`/`MailFolders`) | Avoid a second fetch when the user does open that section, per its own comment | Every `/app/*` mount | Full list, every visit, whether or not the section is ever opened | Most users likely check at least one of Chats/Channels/Mail per session, but NOT reliably all three | **Questionable** — real benefit for whichever section the user does open, real cost for whichever they don't; see Q for the actual trade-off math |
| Search.tsx's directory/assigned/sent | Instant client-side filtering, no round trip per keystroke | Search page mount, before typing | 3 fresh requests just to open Search | Search is a deliberately-reached feature (icon click), so the population that "commonly navigates" there is smaller than AppShell's audience | **Useful prefetch, bounded to an explicit action** — not "unnecessary," but CONDITIONAL on whether zero-keystroke instant results are worth the cost (Hard Rule #11) |
| Electron sticky reconcile from local cache | Offline-first: a sticky note should paint instantly on launch before the WS reconnects | App launch, unconditional, no network | Zero network cost (local disk only) | N/A — not a network prefetch at all | **Required, not really a "prefetch" in the API sense** |

No blind/unnecessary prefetch (data fetched that nothing plausibly needs)
was found — every prefetch identified has a real, stated consumer.

---

## M. Cache & Refetch Audit

Global default: `staleTime: 10_000, refetchOnWindowFocus: false`
(`App.tsx:160-175`). Every override found, repo-wide:

| File:line | Override | Fetches | Note |
|---|---|---|---|
| `BrowserStickies.tsx:145-146` | `refetchOnWindowFocus:true, staleTime:5_000` | `tasksSticky()` | Gated correctly (see J) |
| `AvailablePeople.tsx:36-40` | `refetchInterval:20_000` | **stale `presence()`** | Bug, see Q2 |
| `IncomingMeetingNotice.tsx:115-120` | `staleTime:60_000` | `call(id)`, gated | Clean |
| `Tasks.tsx:133-138`, `MailList.tsx:123-128`, `MailTask.tsx:36-41` | `refetchOnWindowFocus:true` (×3, same pattern) | `qk.taskPins` (desktop-only) | Repeated pattern, not a correctness problem — a shared hook would reduce duplication but that's a code-quality note, not a lazy-loading one |
| `MailCompose.tsx:54-62` | `refetchOnWindowFocus:false, staleTime:Infinity` | `mail(draftId)`, gated | Deliberate ("the composer is the only writer") |
| `MeetingHost.tsx:92-100` | `staleTime:0` | `call(id)`, gated correctly | Clean |
| `MemberDetail.tsx:73-78`, `MembersList.tsx:35-40` | `refetchInterval:60_000` | `memberActivity()`, admin-only, shared key | Clean, shared cache |
| `useAttachmentLinks.ts:28-37` | `staleTime`/`refetchInterval` = 8min | signed URLs | Legitimate — matches a 10min server TTL |
| `CallWindow.tsx:70-83` | `staleTime:0` | `call(id)`, gated | Own tab, correctly scoped |
| `ChannelView.tsx:179-188` | `refetchInterval:30_000` | `channelReadReceipts(id)` | Correctly scoped to the open channel only |
| `useStaticMap.ts:26-35` | `staleTime:Infinity` | map tiles | Legitimate — fixed coordinates never change |
| `useAvailability.ts:34-40` | `refetchInterval:30_000, refetchOnWindowFocus:true` | `availability()` | Already known; runs the whole time any Tasks sub-view is open, not just the Available bucket |
| `usePresence.ts:84-103` | `refetchInterval:20_000` per batch | chunked `presenceOf()` | Correctly scoped to whichever list is mounted |
| `usePresence.ts:138-146` | `refetchInterval:20_000` | `onCallUserIds()` | Correctly scoped |

No case of "open → fetch → leave → return → fetch again unnecessarily"
was found — React Query's cache (`staleTime:10_000` default, longer
per-query overrides above) means a return within the stale window is a
cache hit, confirmed by inspection rather than assumed.

---

## N. WebSocket/Realtime Audit

One live connection per authenticated window (web: direct `WsClient`;
Electron main window: relayed through the `ws-process` utility process via
`config.eventSource`; Electron meeting window: its own direct `WsClient`,
confirmed independent — see O). Connection itself is legitimately global
(see E2).

**Critically, the event-handling side does NOT independently cause the
premature-fetch problem**: `WsEventBridge`'s handler
(`queryBridge.tsx:82-158`) dispatches every event type (calls, messages,
channels, tasks, notifications, mail, presence) to domain-specific
handlers that call `invalidate()` — a coalesced `queryClient.invalidateQueries`
wrapper. React Query's default `invalidateQueries` only force-refetches
queries that are currently *active* (mounted/observed); it marks inactive
ones merely stale for their next real mount. So a `message.created` event
arriving while the user is on the Tasks screen does not itself trigger a
new Conversations fetch — it just means the next time Chats is opened,
the (already-stale-tagged) cache is skipped in favor of a fresh read. This
cleanly separates the WS layer (correctly global, doesn't over-fetch) from
the AppShell layer (the actual source of eager full-list fetches).

Electron-specific: the meeting window opens a **second, independent**
direct `WsClient` connection of its own (`CallWindow.tsx:68` →
`useConnectEventBridge()`, `config.eventSource` absent for that window by
design — `renderer/main.tsx`'s own comment). This is correctly scoped to
that window's lifetime (tied to an active call), not a redundant
duplicate of the main connection, but worth recording as real connection
count if that number ever matters operationally.

---

## O. Electron Startup Audit

Full trace (main process → preload → renderer → ws-process) confirms the
central auth-gating question directly, not by assumption:

- `ws-process.ts` is forked and configured unconditionally at launch
  (`main/index.ts:265,365-366`), but this is **inert** — constructing
  `ApiClient`/`WsClient` objects performs no I/O.
- The actual `ws.connect()` and the `tasksSticky()`/`stickyPins()` REST
  calls only fire inside `case "token"` in `ws-process.ts:187-203`,
  **gated on a truthy token** forwarded over IPC from the renderer's own
  `refreshSession()` result. Traced the full chain: renderer session
  bootstrap → `bridge.setToken` → `ipcRenderer.send("auth:token")` →
  main → `wsProc.postMessage({type:"token"})` → this gate. **Confirmed:
  not eager regardless of login state.**
- A sticky task note CAN appear before that resolves, but only from a
  **local, offline disk cache** with no network involved
  (`main/index.ts:222-225`, `sticky-manager.ts:129-133`) — explicitly
  documented offline-first design, not a premature fetch.
- **Real finding**: packaged builds default to `openAtLogin:true,
  openAsHidden:true` (`main/index.ts:233-242`). The hidden main window
  still fully loads and runs the renderer — including, once a stale-but-valid
  refresh token silently succeeds, AppShell's four unconditional queries
  (D1) — with the window never shown (`windows.ts:49,70-78`, `show:false`
  until `ready-to-show` AND `!startHidden`). This is the one place where
  the shared-layer AppShell issue fires with genuinely zero user action —
  not just "before the user opens that section" but "before the user has
  interacted with the app at all this boot."
- The Electron auto-updater (`updater.ts`) makes a real, unconditional,
  unauthenticated network call at every launch, then repeats every 3
  minutes indefinitely — gated only on `app.isPackaged`. This is standard
  self-update behavior for this class of app, not a "service API called
  too early" in the sense this audit targets, but it is real background
  network activity worth having on record (E4).
- Sticky/chat-sticky/meeting-invite secondary renderer windows: confirmed
  **zero** direct network code (no `fetch`, no `WebSocket`, no API client
  import) — pure IPC display surfaces. A sticky window CAN exist and run
  while not visually shown (`shouldFloatNotesNow()` gate,
  `windows.ts:235-239`) — by design, for the "float over other apps"
  widget behavior — but this never triggers its own fetch; all data
  arrives over IPC from the one already-gated `ws-process`.
- Multi-window: meeting/sticky/meeting-invite windows never mount
  `AppShell` (confirmed via routing — `CallWindow` is a sibling top-level
  route, sticky windows are separate Vite entry points that don't import
  the shared router at all), so none of them re-trigger the
  notifications/conversations/channels/inboxPeers fetch.

---

## P. Initial Load Request Comparison

**Realistic user who only ever uses Tasks, current behavior:**

```text
App launch / first /app/* navigation:
  notifications()      ✓  (AppShell — unconditional)
  conversations()       ✓  (AppShell — unconditional)
  channels()            ✓  (AppShell — unconditional)
  inboxPeers()           ✓  (AppShell — unconditional)
Tasks opened (this user's actual destination):
  taskAssigned()         ✓  (needed)
  tasksSent()             ✓  (needed, "mine" view)
  directory()              ✓  (needed, Available bucket)
  taskAvailability()        ✓  (needed) + 30s poll
```

**4 of the 8 startup-adjacent requests belong to services this user never
opens.** This is a measured count from the actual code paths traced
above, not an estimate — CONFIRMED, not calculated from assumed traffic
numbers (no request-volume/analytics data was available or used).

**Desired, if AppShell's badges were served by a lightweight endpoint
instead of the full lists:**

```text
App launch:
  notification-count()     ✓  (cheap)
  conversation-count()      ✓  (cheap)
  channel-count()            ✓  (cheap)
  inbox-peer-count()          ✓  (cheap)
Tasks opened:
  taskAssigned() / tasksSent() / directory() / taskAvailability()  ✓
```

Same request *count* at startup, but each replaced by an endpoint that
returns a number instead of a full list — the actual byte/DB-query cost
drops, not the call count. **This requires new backend endpoints; it is
not achievable by a frontend-only change** (confirmed no such endpoints
exist today, section D1).

---

## Q. Expected Backend/DB/Redis Impact

**Q1 — AppShell's four queries, honestly assessed.** Deferring them
outright (not replacing with a lightweight endpoint) would reduce backend
request count and DB query load for any user who doesn't open that
section in a given session, at the direct cost of losing accurate sidebar
badge counts for unopened sections — a real product regression, not a
free win. The alternative (a lightweight count-only endpoint per service)
preserves the badge UX and still cuts the *data volume* per request
(a count vs. a full conversation/channel list, each potentially
containing dozens of rows with names/previews/timestamps) — this is a
real DB-query-shape improvement (a `COUNT()`/aggregate query instead of a
full row scan with joins) without giving anything up, but it is backend
work, not something this audit's frontend evidence alone can size in
exact numbers. **Marked ESTIMATE, not measured**: no query-plan or
production-traffic data was available this pass to quantify DB/Redis
impact precisely.

**Q2 — `AvailablePeople.tsx`'s stale org-wide presence poll.** This is the
one finding in this audit with a clear, quantifiable, no-trade-off fix:
`usePresence.ts`'s own doc comment explicitly states the org-wide
`GET /presence` endpoint was replaced by chunked per-user
`POST /presence/query` specifically because polling an entire
organization's presence set every 20 seconds does not scale, and that
"nothing in the repository called [the old endpoint]" at the time of that
migration — except this one file evidently still does, independently,
with its own 20s interval. Every user who opens Tasks and sees the
Available bucket is running the exact query pattern the rest of the
platform already paid the cost to migrate away from. Fixing this is a
one-file swap to an existing hook (`usePresence()`), not new
architecture — the highest confidence, lowest-risk fix in this whole
audit.

**Q3 — Electron auto-start-at-login (O).** Every machine with
`openAtLogin` enabled and a still-valid refresh token now performs the
full AppShell fetch set on every OS boot, in a hidden window, whether or
not the user ever opens the app that session. This multiplies D1's cost
by "every configured machine, every boot" rather than "every app open" —
worth weighing when prioritizing D1's fix, since the Electron population
pays this cost unconditionally.

**No Kafka/NATS involvement** was found in any of the audited fetch paths
— every query traced is a direct REST (or, where `graphBase` is
configured, GraphQL) call against a service's own read path, not
something that fans out through the event pipeline.

---

## R. Correctness & Edge Cases

Every scenario Phase 18 lists, checked against what was actually traced
(not assumed):

- **Direct route navigation / deep links / bookmarks**: confirmed safe —
  every feature route's data hooks are `enabled` on the route's own params
  (`enabled: !!channelId`, `!!conversationId`, `!!callId`, etc.), so
  landing directly on `/app/channels/:channelId` fetches exactly what that
  screen needs, the same as navigating there from the sidebar. No route
  in the audited set depends on AppShell having *previously* fetched
  something it wouldn't fetch itself on a cold direct load.
- **Browser refresh**: `SessionBootstrap` re-runs `refreshSession()` from
  scratch (App.tsx:406-428), and AppShell's four queries re-fire exactly
  as they do on any fresh mount — behavior doesn't change across a
  refresh, so no NEW correctness risk here specifically. (It does mean
  the four-query cost repeats on every refresh — same finding as D1,
  not a new one.)
- **Org/workspace switching**: `WsEventBridge`'s connect effect is keyed
  on `orgId` (`queryBridge.tsx:70-72`) — reconnects and re-subscribes
  under the new token on switch. AppShell's own queries aren't explicitly
  keyed by org in what was traced this pass — **UNKNOWN** whether a stale
  cross-org cache entry could show briefly during a switch; this specific
  question needs its own targeted trace before any implementation, not
  answered by this audit.
- **Logout/login**: `RequireAuth` gates on live session status, so
  AppShell unmounts on logout (React Query cache for its keys goes stale/
  inactive, not fetched again until a real re-mount) and re-mounts +
  re-fetches on the next login — no different from today's behavior,
  confirmed structurally sound.
- **Reconnect / offline-online**: WS reconnect (web `WsClient`, Electron
  `ws-process` crash-recovery with backoff, `main/index.ts:372-384`) is
  independent of AppShell's queries; a socket drop doesn't itself
  invalidate/refetch anything (see N) — only live events do, and there
  are none to receive while disconnected.
- **Notification badges / unread counts during any of the above**: these
  are exactly what D1 is about — they stay correct today because the full
  list is always fetched; any change here must preserve accuracy, which
  is precisely why D1's recommendation is "replace with an equivalent
  cheap source," not "just remove."

---

## S. Minimal Implementation Plan

**Not implemented. Ordered by risk/benefit, smallest change first.**

### S1. Fix `AvailablePeople.tsx`'s stale presence call (LOWEST risk, clear win)
```text
Priority: High benefit / lowest risk — do this one regardless of the rest
Files: packages/app/src/features/AvailablePeople.tsx
Current behavior: independent api.presence() call, 20s interval, org-wide
Desired behavior: use usePresence() (packages/app/src/lib/usePresence.ts),
  the already-built, already-used-elsewhere chunked replacement
Exact trigger: same as today — Tasks "Available" bucket rendered
Potential dependencies: none — usePresence() is already a stable, shared hook
Risk: Low — same data shape, same consumers, removes a poll rather than adding one
Testing required: open Tasks → Available bucket, confirm presence still
  renders correctly; confirm the old org-wide endpoint is no longer called
  (network tab / server access log)
Rollback strategy: revert the one file
```

### S2. Gate Search.tsx's three cross-domain queries (CONDITIONAL — needs a product decision first)
```text
Priority: Medium — real savings, but trades away instant zero-keystroke results
Files: packages/app/src/routes/Search.tsx
Current behavior: directory()/taskAssigned()/tasksSent() fire on Search mount
Desired behavior: enabled: query.length > 0 (or a short debounce)
Exact trigger: user has typed at least one character
Potential dependencies: none technically; PRODUCT must confirm the instant-
  empty-state UX (if any) doesn't depend on data being pre-loaded
Risk: Low technically, Medium product — could visibly slow the very first
  search after opening the page
Testing required: open Search, confirm no network calls until typing; type
  a query, confirm results still populate correctly
Rollback strategy: revert the enabled condition
```

### S3. Replace AppShell's badge fetches with lightweight endpoints (HIGHEST benefit, requires backend work)
```text
Priority: Highest total-impact item in this audit, but NOT a frontend-only
  change — sequence this after backend capacity to build the endpoints
Files (frontend): packages/app/src/routes/AppShell.tsx (swap the four
  queryFns once the endpoints exist)
Files (backend, NEW work, not scoped/estimated by this audit): a
  notifications unread-count endpoint, a conversations unread-count
  endpoint, a channels unread-count endpoint (messaging-svc), an
  inbox-peers unread-count endpoint
Current behavior: 4 full-list fetches on every /app/* mount
Desired behavior: 4 lightweight count fetches on every /app/* mount; the
  FULL lists still fetch, unchanged, the first time ChatsList/ChannelsList/
  MailFolders actually mount (today's cache-priming benefit is lost for
  those three — a real, small regression to accept: the FIRST time a
  section opens, it now costs a real fetch instead of a cache hit; every
  visit before that is now cheaper)
Exact trigger: unchanged (AppShell mount)
Potential dependencies: new backend endpoints must exist and be correct
  (unread math must match what the full-list summation produces today, or
  badges will disagree with the list once opened)
Risk: Medium — a badge/list mismatch bug is very visible to users; needs
  careful before/after parity testing against the current summation logic
Testing required: for each of the 3 replaced endpoints, verify the new
  count matches summing .unread across the old full-list response, for a
  range of real accounts (zero unread, some unread, org-wide edge cases)
Rollback strategy: revert AppShell to the full-list queryFns; the new
  endpoints can stay deployed unused
```

### S4. AppShell's `notifications()` specifically (LOW risk, no dual-purpose to preserve)
```text
Priority: Medium — smaller win than S3 but zero backend dependency if the
  badge is allowed to show 0/stale until the bell is first opened
Files: packages/app/src/routes/AppShell.tsx
Current behavior: notifications() fetched unconditionally on every mount
Desired behavior: enabled on first bell-open, OR keep as-is until a
  lightweight count endpoint exists (see S3) — this is the one query with
  no list-pane to prime, so deferring it costs nothing but an accurate
  startup badge
Risk: Low-medium — the bell badge would show stale/zero until first open,
  a visible UX change users may notice immediately
Testing required: confirm the badge does eventually show the right count
  after first open; decide product-side whether a temporarily-blank badge
  is acceptable
Rollback strategy: revert the enabled condition
```

**Electron auto-start-at-login (O) is deliberately NOT in this plan** —
it's a consequence of D1, not a separate bug; fixing S3/S4 fixes it too,
automatically, with no Electron-specific code change needed.

---

## T. Validation & Test Plan

All ten tests the spec requires, mapped to what would actually need
checking against the code paths this audit traced:

1. **Startup test** — open the app, land on `/app` without navigating.
   Confirm (network tab) that ONLY the current AppShell four (or their
   replacement counts, post-S3) fire — no Tasks/Channels-detail/Mail-
   detail/Meetings-specific calls.
2. **Channels test** — open Channels. Confirm `channelMessages`,
   `channelReactions`, `channelReadReceipts` fire; confirm `channels()`
   itself is a cache hit (no new network call) if AppShell already primed
   it, or a real fetch if S3 has shipped and decoupled them.
3. **Tasks test** — open Tasks. Confirm all four Tasks-domain calls fire
   (this is CORRECT, expected behavior per D1/G — the test should assert
   they fire, not that they don't).
4. **Mail test** — open Mail. Confirm `MailList`'s unified-inbox fetch
   fires; confirm `inboxPeers` is a cache hit pre-S3.
5. **Direct-route test** — load `/app/channels/:id` directly (hard
   refresh or typed URL). Confirm the SAME set of channel-detail queries
   fire as the click-through path — per R, this should already pass
   without any change, since every feature query is `enabled` on its own
   route params, not on AppShell having primed anything.
6. **Refresh test** — refresh while on any `/app/*` page. Confirm
   AppShell's four re-fire (expected, unchanged by this audit) and the
   current page's own queries also re-fire correctly.
7. **Tab-switch test** — Chats → Channels → Chats. Confirm no duplicate
   fetch within the 10s global `staleTime` window; confirm a switch after
   `staleTime` expires DOES refetch (that's correct cache behavior, not a
   bug).
8. **Cache test** — open Members → leave → reopen within `staleTime`.
   Confirm `directory()` is a cache hit the second time.
9. **Auth test** — logout, confirm AppShell's queries stop (component
   unmounts under `RequireAuth`); login again, confirm they re-fire
   correctly for the new session, not a stale/wrong-org cache entry (see
   R's flagged UNKNOWN on org-switch cache keying — this test should be
   extended to explicitly check that case before any S3/S4 rollout).
10. **Network test** — compare a fresh-login network log before and after
    any of S1-S4 ships; confirm the specific calls each change targets
    are gone/reduced and nothing else regresses.

---

## U. Risks

| Risk | Applies to | Severity | Mitigation |
|---|---|---|---|
| Badge/list count mismatch after switching to lightweight endpoints | S3 | Medium — visible to every user | Parity-test new endpoints against today's full-list summation before rollout |
| First-section-open latency increase (cache-priming benefit lost) | S3, S4 | Low — one extra round trip, once per session per section | Accept as a known, bounded trade-off; not a correctness risk |
| Search feels slower on first keystroke | S2 | Low-medium, product-visible | Needs explicit product sign-off, not just engineering judgment |
| Org-switch cache-key correctness (UNKNOWN, not fully traced) | Any change to AppShell's query keys | Unknown until traced further | Trace this specifically before touching AppShell's query definitions, independent of D1's fix |
| None of S1-S4 touches auth, WS connection lifecycle, or delivery guarantees | — | — | By design — every recommendation here is scoped to read-path list/badge queries, nothing in the real-time or auth path |

---

## V. Final Recommendation

Ship in this order: **S1 (AvailablePeople fix) first — it is a strict,
low-risk win with no trade-off.** S4 next if the product accepts a
temporarily-inaccurate notification badge, since it needs no backend
work. S3 (the real fix for D1's conversations/channels/inboxPeers) is the
highest-value item in this audit but is backend-gated — schedule it as
backend capacity allows, not as a quick frontend patch, and treat the
parity test in S3's testing section as a hard requirement before
shipping, not optional. S2 (Search) is a product decision, not an
engineering one — surface the trade-off and let product decide rather
than defaulting either way.

Do **not** attempt to make every AppShell query lazy without the
lightweight-endpoint work in S3 — doing so would trade a real,
measurable backend-load reduction for a real, user-visible loss of
accurate sidebar badges, which is exactly the kind of naive
"lazy-everything" mistake Hard Rule #10 and the spec's own closing
paragraph warn against.

---

```text
STATUS: CONDITIONAL PASS

Current unnecessary startup API calls:
4 (AppShell: notifications, conversations, channels, inboxPeers — all
CONFIRMED via direct code read, all firing on every /app/* mount
regardless of section)

APIs recommended for on-demand loading:
8 distinct call sites across 4 findings — AppShell's 4 (D1, recommend
lightweight-endpoint replacement per S3/S4, not blind removal), Search's
3 (D2, CONDITIONAL on product decision, S2), AvailablePeople's 1 stale
endpoint (Q2, S1, the one unconditional recommendation in this audit)

APIs that must remain global:
4 categories (E1-E4): auth/session bootstrap, the post-auth WebSocket
connection, cross-cutting sticky task-note delivery, Electron auto-updater

Highest-impact optimization:
Replacing AppShell's 4 full-list badge queries with lightweight
count-only endpoints (S3) — but this is backend-gated, not a same-day
frontend change

Expected startup request reduction:
CALCULATED (not measured — no production traffic data was available this
pass): 4 of 8 typical-Tasks-user startup-adjacent requests belong to
services never opened this session (P); AvailablePeople's fix removes one
entire redundant polling endpoint (Q2) with zero trade-off

Primary correctness risk:
Badge/list count mismatch if S3's replacement endpoints don't exactly
match today's full-list summation logic; also an UNKNOWN (not fully
traced) question about AppShell query cache-key correctness across an
org switch, flagged in R for follow-up before implementation

Implementation complexity:
S1: LOW · S2: LOW (technically) · S3: MEDIUM-HIGH (new backend endpoints
+ parity testing) · S4: LOW

Implementation readiness:
S1: READY · S2: NEEDS PRODUCT DECISION · S3: NEEDS BACKEND SCOPING (not
started this audit) · S4: READY, pending a product call on badge accuracy
```
