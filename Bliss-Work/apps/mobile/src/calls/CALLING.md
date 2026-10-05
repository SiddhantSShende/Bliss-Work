# In-app calling (mobile)

All BlissWork calls on mobile run inside the app. Nothing in the call path opens
Chrome, Safari or a WebView.

## Why Chrome used to open

Mobile had no WebRTC, so every call entry point ended in
`Linking.openURL(`${webBaseUrl}/call/<id>`)`, which hands the web room to the
device browser:

| Entry point | Old behaviour |
| --- | --- |
| Chat → Voice/Video call | `scheduleMeeting` then `Linking.openURL(/call/<id>)` |
| Meeting → Join / Open the room | `Linking.openURL(/call/<id>)` |
| Tapping a shared call link in chat | `Linking.openURL(link)` |
| Channel → Call | no call button existed |
| Incoming call | nothing on mobile listened for `call.invite` frames |

The root cause was the missing native media stack plus a browser hand-off, not a
routing bug. The fix is a native call layer that speaks the backend's existing
protocol; the URLs are now parsed and joined in-app (`callLinks.ts`).

## How it talks to the backend (unchanged backend, unchanged web/desktop)

| Kind | Signalling | Media |
| --- | --- | --- |
| 1:1 (Chat) | WS control frames `call.invite/accept/decline/cancel/end` + `rtc.offer/answer/ice` (same as web `useCall`) | P2P `RTCPeerConnection`, STUN/TURN from `GET /turn-credentials` |
| Room (channel, meeting, widened 1:1) | `POST /calls/:id/token` (JOINED / WAITING), `call.started` / `call.ended` events, `POST /calls/:id/leave|end` | LiveKit SFU |

A mobile user and a web/desktop user can call each other: the wire format, the
`call-meta` data channel, and the fixed caller/callee roles match web's
`CallSession`. No file outside `apps/mobile` was changed.

## Layout

- `callController.ts` — 1:1 state machine (`idle → outgoing/incoming → connecting → connected ⇄ reconnecting → ended | rejected | failed`). No React/native imports; unit-tested.
- `roomController.ts` — room state machine (`ringing → joining → waiting → connected ⇄ reconnecting → ended | failed`). Unit-tested.
- `MobileCallSession.ts`, `LiveKitRoomAdapter.ts` — the only files touching the native WebRTC / LiveKit APIs.
- `CallProvider.tsx` — wires controllers to the WS, notifications, audio routing, permissions, deep links. Mounted in `AppProviders` (signed-in only).
- `CallOverlay.tsx` — ring screen, active call, room grid, failed/ended states, Add member. Renders through GlassProvider's overlay layer (see below).
- `addPeople.ts` — pure helpers for Add member (sequential adds, failure text, notices, hardware-Back decision). Unit-tested.
- `notifications.ts`, `audio.ts`, `permissions.ts`, `callLinks.ts`.

## What actually rings a phone (verified against messaging-svc / ws-gateway)

| Call | What the server sends the callee | Handled by |
| --- | --- | --- |
| 1:1 (Chat) | WS control frame `call.invite` (gateway stamps `fromUserId`, `fromName`), only if the callee has an open socket in the same org; otherwise the caller gets `rtc.peer.unreachable` | `callController.ts` |
| Channel "call now" / meeting "meet now" | ONLY `call.scheduled` with `status: "LIVE"` to the roster. No `call.started`, no `call.ring` | `roomInvites.ts` |
| Scheduled call, host presses Start | `call.started` to the roster | `roomInvites.ts` |
| Someone adds you to a call | `call.ring` to you, then `call.participant_added` to everyone INCLUDING you (`actorId` = the adder) | `roomInvites.ts` (must not dismiss the ring) |

`roomInvites.ts` is pure and tested with payloads parsed by the shared zod schema.

## Incoming calls: what works, and what does not

The ring screen is a phone-style slider (`SlideToAnswer.tsx`): caller photo,
full name, @username and "BlissWork Audio/Video Call" from the ring frame and
the shared directory cache (`useCallerProfile.ts`, no extra request). Drag the
thumb right to answer, left to decline; both call `direct.accept()/decline()`
(or `room.join()/decline()`), the same controller methods the old buttons did.
TalkBack/VoiceOver get "Answer" / "Decline" accessibility actions.

| Situation | Behaviour |
| --- | --- |
| App open | In-app slide-to-answer ring screen. No system notification (avoids a duplicate). |
| Android, backgrounded, process alive (WS connected) | ONE call-style notification (`IncomingCallModule.kt`: CATEGORY_CALL, Answer/Decline, looping ringtone) with a full-screen intent. Device in use -> heads-up. Tapping it opens the ring screen. |
| Android, screen off / locked, process alive | Same notification; Android launches the app over the lock screen (`setShowWhenLocked` + `setTurnScreenOn`) showing the slide-to-answer screen. A secure lock screen is not bypassed: Answer works on the call screen, the rest of the app stays locked. |
| iOS, backgrounded | Local notification with Accept / Decline (expo-notifications), tap opens the ring screen. Not a CallKit screen. |
| **App killed / OS-frozen (either OS)** | **Not supported.** |

Android 14+ can revoke the "full-screen notifications" access; the app asks once
(`offerFullScreenCalls`) and links to that system page. Without it the call
still rings as a heads-up notification, just not over a locked screen.

Killed-app calls, and iOS CallKit, need a server-sent push (FCM on Android,
APNs VoIP + PushKit on iOS). The backend has no push-registration endpoint,
the repo has no `google-services.json`, and `call.invite` is an ephemeral WS
frame that is not replayed. iOS cannot be woken to show CallKit without that
VoIP push (a backgrounded iOS app's socket is suspended within seconds), so
CallKit is deliberately NOT added here. The client half (token registration,
a high-priority data-message handler that calls `IncomingCallModule.show`, and
CallKit) can be added without changing the controllers.

Not implemented: an Android foreground service for keeping the microphone live
when the app is backgrounded mid-call *without* Picture-in-Picture (PiP keeps
it live; see `../meetings/MEETINGS.md`), iOS screen sharing (needs a ReplayKit
broadcast extension), Bluetooth headset routing beyond what the OS does by
default. Screen sharing from Android and viewing a peer's share both work in
meetings.

## Add member (voice and video, 1:1 and room)

The button is "Add member" (person-plus icon + label) under the call status once
a call is connected. It opens `MemberPickerSheet` (real directory, presence,
search, checkmarks; everyone already in the call is disabled as "In this call").

It reuses web's mechanism exactly (packages/app `useCall.tsx` `addPeople`,
`useCallRoom.ts` `addPeople`), no new backend:

| Call | Steps |
| --- | --- |
| Room (channel, meeting, widened) | `POST /calls/:id/participants {userId}` per person, sequentially. Server rings the newcomer (`call.ring`) and sends `call.participant_added` to the roster. |
| 1:1 | `POST /calls/:id/token` on the call row first (proves the SFU is reachable, and marks us present, which the server requires of whoever adds), then the same POSTs, then `{t:"room"}` over the data channel so the peer moves too, then this device closes its P2P session and joins the room (`CallController.addPeople` -> `onEnterRoom`). |

The row id of a 1:1 call is `CallSnapshot.recordId` (caller: minted by
`startDirectCall`; callee: received over the data channel). Until it exists the
button is disabled with "Getting the call ready...".

Failures are per person and always visible (`summarizeOutcome`): the server
answers 403 for "not in this channel", "blocked" and "different org" alike, so
the text says so. If nobody could be added, a 1:1 call stays peer-to-peer.

## Background blur and layering

`CallOverlay` renders nothing itself; it publishes `CallLayer` into
`GlassProvider` (mounted in App.tsx, `<CallOverlay/>` inside it). Stack:

    app (BlurTargetView) -> full-screen BlurView (blurTarget = the app)
      -> theme-tinted wash (colors.bg, alpha) -> call UI -> sharp controls

The layer is absolutely filled over the whole window (edge-to-edge, so the
status/navigation bars too); only the controls apply safe-area insets. It fades
in with the native driver and stays mounted through a 1:1 -> room hand-over.
The picker is a later GlassProvider layer, so it stacks above the call.
Over live 1:1 video the remote video is opaque; controls there use a dark
translucent skin (iOS also blurs the video natively; Android cannot blur a
video surface). Hardware Back asks before leaving a live call (`backAction`).

## New meeting: Start Now vs Schedule, and the 10-minute reminder

`ScheduleMeetingScreen` mirrors web's NewMeetingDialog contract (`lib/meetingSchedule.ts`):
`classifyStart` compares real `Date` instants with a 60 s grace (the server's
`scheduleGraceWindow`): within it -> **Start Now** (`scheduleMeeting` with no
`scheduledAt`, then join in-app); further ahead -> **Schedule** (`scheduledAt` as
an ISO instant + `durationMinutes = end - start`); further behind -> "Start time
has already passed." End must be strictly after start. An untouched start/end
follows the clock; a value the user picked is never changed for them.

Reminders (`meetingReminders.ts`) are dated LOCAL notifications, delivered by the
OS (AlarmManager / UNUserNotificationCenter), so they fire with the app closed,
backgrounded or the phone locked. They are NOT a server push: the backend has no
reminder job and no push registration. `syncMeetingReminders` reconciles the
device's pending reminders to `GET /calls` (creator + invitees) on every change of
that list and on returning to the foreground: id = `meeting-reminder:<callId>:10m:<startMs>`
(one per meeting+start; a moved meeting gets a new id and the old one is
cancelled; cancelled/ended/deleted meetings are cancelled). Known limits: a device
that has not synced since a change cannot learn of it (an invitee whose app has
not run since being invited gets no reminder; a cancellation while the app is
closed still fires the old reminder, and tapping Join then says "unavailable");
iOS keeps at most 64 pending local notifications (we cap at 48); Android delivers
on the exact minute only where exact alarms are allowed (`SCHEDULE_EXACT_ALARM`).
