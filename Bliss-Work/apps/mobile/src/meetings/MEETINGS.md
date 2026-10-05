# In-app meetings (mobile)

A meeting joins the SAME LiveKit room web/desktop use (`POST /calls/:id/token`,
via `calls/roomController.ts`) and runs entirely inside the app. There is no
browser hand-off anywhere in the meeting path.

## Screens

- `screens/meetings/MeetingDetailScreen.tsx` — hero (title, time, participants, status), **Join Meeting**, meeting id + share-invite (`POST /calls/:id/invites` -> system share sheet), organizer, roster, Add member, Start / Leave / End / Cancel.
- `MeetingRoom.tsx` — the full-screen meeting (mounted by `calls/CallOverlay.tsx` for `joining | waiting | connected | reconnecting`).
- `MeetingStage.tsx` + `layout.ts` — stage (shared screen > pinned > active speaker), grid, 1/2/many participants, portrait/landscape. `layout.ts` is pure and tested.
- `MeetingPanel.tsx` — Chat / Participants / Notes tabs over the live stage.
- `MeetingBar.tsx` (minimized), `MeetingPip.tsx` (system PiP window), `MeetingOverlays.tsx` (menu, leave dialog), `Glass.tsx` (real blur).

## What each control does

| Control | Real effect |
| --- | --- |
| Mute / Camera | publishes/unpublishes the LiveKit mic/camera track (`roomController.toggleMic/toggleCam`) |
| Share (Android) | `setScreenShareEnabled` -> `getDisplayMedia` -> MediaProjection (consent dialog + foreground service), then `POST /calls/:id/share`; STOP or the system's stop both clean up |
| Members / Add Member | roster from the room; Add member uses `MemberPickerSheet` + `POST /calls/:id/participants` (server rings the newcomer) |
| Chat | data channel (web wire format, `roomData.ts`) + own room-wide messages saved with `saveCallChat`; history read with `callChat`; private messages stay on the wire |
| Notes | same channel; saved with `saveCallNote`, read with `callNotes` |
| End / Leave | `leaveCall` (all), `endCall` (host, "End for everyone") |

`meetingData.ts` (chat/notes store) and `meetingHub.ts` (one per live meeting) are pure and unit-tested with fake transports.

## Minimize and Picture-in-Picture

- Back, or the chevron, **minimizes** in-app: a slim bar (`MeetingBar`) and the rest of BlissWork is usable while the call continues.
- Leaving the app (Home, recents) shrinks the meeting into **Android PiP** (armed while connected: `pip.ts` -> `MeetingPipModule.kt`; API 31+ auto-enter, API 26-30 via `MainActivity.onUserLeaveHint`). A PiP activity keeps its microphone and connection. `meetingUi.ts` mirrors minimized/PiP state; returning restores the full meeting.
- Not done: a foreground service for microphone use when PiP is unavailable/disabled (Android 11+ silences a fully backgrounded app's mic); iOS PiP.

## Blur

Panels, the menu and the leave dialog blur the LIVE stage behind them: the stage
is an expo-blur `BlurTargetView`, each panel's `BlurView` points at it (`Glass.tsx`).
Text and buttons are siblings above the blur, so they stay sharp. Android cannot
capture a video surface in a blur, so video tiles behind a panel are not blurred
(avatars, gradient and tiles without video are).
