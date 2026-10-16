import type { ServerEvent, ClientFrame, ControlFrame, PinResult, WsEventMeta } from "@taskboard/shared";

/**
 * Platform abstraction — the one seam between the web shell and the Electron
 * renderer.
 *
 * Web: `eventSource` is undefined, so the app opens its own WebSocket.
 * Electron: a single WS lives in the main process `utilityProcess` (so it
 * survives the main window being minimized/closed). The renderer receives every
 * ServerEvent through `eventSource` instead of opening a second socket, and
 * forwards the access token via `persistToken` so the utilityProcess can auth.
 */
export interface EventSource {
  /** Ask the host (utilityProcess) to (re)connect its socket. */
  connect: () => void;
  /**
   * Ask the host to DROP its socket, on sign-out.
   *
   * The socket is what the gateway counts as presence, and the desktop's lives
   * in a utilityProcess that outlives the window on purpose — so unmounting the
   * React tree, which is all a web sign-out has to do, leaves it connected and
   * the person online to their whole organisation after they signed out.
   *
   * Optional so a host that predates it still compiles; a missing one means the
   * caller cannot hang up, not that it should not try.
   */
  disconnect?: () => void;
  /**
   * Subscribe to forwarded ServerEvents; returns an unsubscribe fn.
   *
   * `meta.replayed` marks the connect-time catch-up burst. It has to cross the
   * IPC boundary because the socket lives in the utilityProcess while the
   * toasts fire in the renderer — without it, every desktop launch re-announces
   * the last 200 events. Optional so a host that predates it still compiles;
   * absent is read as "not replayed", i.e. the old behaviour.
   */
  subscribe: (cb: (e: ServerEvent, meta?: WsEventMeta) => void) => () => void;
}

/**
 * WebRTC signaling transport (Phase 10). Web backs this with the renderer's
 * own WsClient; Electron backs it with an IPC bridge to the ws-process socket.
 */
export interface RtcTransport {
  sendFrame: (frame: ClientFrame) => void;
  onControl: (cb: (f: ControlFrame) => void) => () => void;
}

/**
 * Receiver-side file sink (Phase 10). Web buffers chunks in memory and triggers
 * a browser download on finish; Electron streams each chunk straight to disk via
 * an IPC bridge to the main process, so a multi-GB transfer never has to fit in
 * renderer memory. One logical file per transferId.
 */
export interface FileSink {
  open: (transferId: string, fileName: string, size: number) => Promise<void>;
  write: (transferId: string, data: ArrayBuffer) => Promise<void>;
  /** Finalize + integrity-check: returns true if the received bytes' sha256
   *  matched `expectedSha256` (file kept), false on mismatch (file discarded). */
  finish: (transferId: string, expectedSha256: string) => Promise<boolean>;
  abort: (transferId: string) => void;
}

/** Host side of the desktop pinned-chat windows (Electron main process). */
export interface ChatStickyHost {
  pin: (boot: {
    threadId: string;
    conversationId: string;
    myUserId: string;
    peerUserId: string;
    peerUsername: string;
  }) => void;
  unpin: (threadId: string) => void;
  list: () => Promise<string[]>;
}

/** A meeting window's live state, as the main window's status pill needs it
 *  — see PlatformConfig.pushMeetingWindowStatus/onMeetingWindowStatus. */
export interface MeetingWindowStatus {
  callId: string;
  title: string;
  micOn: boolean;
  camOn: boolean;
  /** Epoch ms — the MEETING's own start time (server call.startedAt), the
   *  same value CallRoom's own header timer is built from. Absent until the
   *  meeting has actually started. */
  startedAt?: number;
  participantCount: number;
}

export interface PlatformConfig {
  /**
   * "mobile" = the React Native app (apps/mobile). It reuses this same
   * config shape (and, unmodified, RuntimeProvider/ApiClient/WsClient) for
   * exactly the fields below that are genuinely platform-agnostic — base
   * URLs, the token getters, wsUrl. Every existing `config.kind === "web"`/
   * `!== "web"`/`=== "electron"` check in this package already degrades
   * correctly for a third value (verified: none of them are an exhaustive
   * switch), so mobile falls into the same "not web"/"not electron" branches
   * electron and web already fall into for each other today. The ~30
   * Electron-only fields further down stay optional and simply absent on
   * mobile, exactly as they're already absent on web.
   */
  kind: "web" | "electron" | "mobile";
  /**
   * Electron main window only: the OS title bar is hidden and TopNavbar is the
   * window's single header, with the native window controls drawn over it
   * (titleBarOverlay — see apps/desktop/src/main/windows.ts). Absent on web,
   * mobile, and the meeting window, which keep an ordinary header.
   */
  windowControls?: {
    /** Edge the native min/max/close controls are drawn on, over the top bar. */
    side: "left" | "right";
    /** Report the top bar's resolved colours so the native controls match the theme. */
    setTheme: (theme: { color: string; symbolColor: string }) => void;
  };
  /**
   * The host measures idle and active time itself, from the OS, and reports it
   * through the telemetry queue — so TelemetryBridge must NOT accrue its own.
   * Its in-window view can only see input landing in its own window, which reads
   * someone working in another application as idle; counting both would credit
   * the same minutes twice. Absent everywhere the host has no such tracker
   * (web, mobile, desktop platforms without one), where the bridge's own
   * accounting is all there is and keeps running.
   */
  osActivityTracking?: boolean;
  /**
   * Collect the finished activity spans the host's tracker has produced since
   * the last call (see lib/activitySpans.ts for the shape and what is done with
   * them). Present exactly when `osActivityTracking` is. Resolves to `unknown`
   * because it crosses an IPC boundary and the caller validates it.
   */
  drainActivitySpans?: () => Promise<unknown>;
  /**
   * The public web app origin — what a meeting-join link (or anything else
   * meant to leave the app and be opened by anybody, with or without
   * BlissWork installed) must be built from.
   *
   * NOT the same thing as `window.location.origin`: on web the two coincide,
   * but the packaged Electron renderer loads from `file://`, so reading
   * `window.location.origin` there produces the opaque `file://` origin —
   * not a link anyone else's browser (or even a plain email client) can open.
   * See lib/meetingDeepLink.ts's `meetingJoinUrl`, the one thing this exists
   * for today.
   */
  webBaseUrl: string;
  authBase: string;
  taskBase: string;
  notificationBase: string;
  messagingBase: string;
  telemetryBase: string;
  /**
   * integrations-svc — connected-account OAuth (Settings > Microsoft 365).
   * OPTIONAL, same reasoning as stickyBase below — mobile has no equivalent
   * Settings surface yet and omits this entirely.
   */
  integrationsBase?: string;
  /**
   * sticky-svc — the durable record of which task notes belong on this user's
   * desktop.
   *
   * OPTIONAL and additive. Absent, the desktop notes behave exactly as they did
   * before the service existed: task-svc's /tasks/sticky is still the content
   * source and still decides what is actionable. Present, a pin also survives a
   * reinstall and follows the user to a second machine. It can never REMOVE a
   * note — see refreshSticky in apps/desktop/src/main/ws-process.ts.
   */
  stickyBase?: string;
  /**
   * Read-composition GraphQL gateway. OPTIONAL — absent means every screen
   * takes its REST path, which is how the gateway rollout stays reversible by
   * configuration instead of by deploy.
   */
  graphBase?: string;
  wsUrl: string;
  /** "browser" for web, "hash" for the Electron file:// renderer. */
  router: "browser" | "hash";
  /** Present only in Electron: realtime events relayed from the utilityProcess. */
  eventSource?: EventSource;
  /** Present only in Electron: rtc.* signaling bridged from the ws-process. */
  rtc?: RtcTransport;
  /** Present only in Electron: disk-backed receiver sink (defaults to an
   *  in-memory blob + browser download on web). */
  fileSink?: FileSink;
  /** Present only in Electron: streaming sha256 of a (possibly huge) file,
   *  computed Node-side so the sender renderer never loads the whole file.
   *  Web falls back to an in-memory hash (its files are small). */
  hashFile?: (file: File) => Promise<string>;
  /**
   * Present only in Electron: raise the incoming-meeting invite as a real,
   * always-on-top OS window (see main/meeting-invite-manager.ts), so it is
   * visible over whatever other application the user is in — not just when
   * BlissWork's own window happens to be focused. `organizer` is a plain
   * label (already resolved to a name, never a raw id) or "" when unknown.
   * Absent on web, where IncomingMeetingNotice renders its own in-page
   * popup instead — a browser tab has no equivalent of an always-on-top
   * window, so there is nothing for this to do there.
   *
   * `adhoc` is true for an ad-hoc call (a 1:1 that is growing into, or already
   * is, a conference) — not a Meeting. `title` already carries the right
   * wording either way (IncomingMeetingNotice computes it); this is what lets
   * the popup's own OS-level window title say "call" rather than "meeting"
   * too, since that is a separate string the body text does not cover.
   */
  showMeetingInvitePopup?: (callId: string, title: string, organizer: string, adhoc?: boolean) => void;
  /**
   * Present only in Electron: the invite popup's Video Call / Voice Call
   * button was clicked (in the SEPARATE popup window, not this one) — join
   * with that media choice, the same way IncomingMeetingNotice's own buttons
   * already do via requestMeetingJoin. Absent on web, where the popup lives
   * in-page and calls requestMeetingJoin directly, no IPC round trip needed.
   */
  onMeetingInviteAction?: (cb: (callId: string, media: "video" | "voice") => void) => () => void;
  /**
   * Present only in Electron: the invite popup's Decline button was clicked
   * (ad-hoc rings only — see renderer/meeting-invite.tsx, which only offers
   * this for `adhoc` invites). The popup window has no api/React Query of
   * its own, so this is what lets IncomingMeetingNotice make the actual
   * declineCall() POST on its behalf, same reasoning as onMeetingInviteAction
   * above. Absent on web, where the in-page card's own Decline button calls
   * declineCall() directly.
   */
  onMeetingInviteDeclined?: (cb: (callId: string) => void) => () => void;
  /**
   * Present only in Electron: the user clicked an OS notification popup. The shell
   * handles it exactly like a click on the bell row or the in-app toast (see
   * NotificationClickBridge): mark `notificationId` read and, if `path` is set,
   * open it. `path` is untrusted — it came over IPC — and is re-checked first.
   */
  onNotificationClick?: (cb: (click: { notificationId: string; path: string | null }) => void) => () => void;
  /**
   * Present only in Electron: the sticky overlay's Chat button was clicked
   * for `taskId`. The overlay window has no router of its own, so main
   * forwards this to the (focused) main window — see TaskChatOpenBridge,
   * which resolves the actual DM/channel target via useOpenTaskDiscussion.
   */
  onTaskChatOpen?: (cb: (open: { taskId: string }) => void) => () => void;
  /**
   * Present only in Electron: close the always-on-top popup window raised by
   * showMeetingInvitePopup for `callId`, without any user action — the call
   * ended, or was answered elsewhere, while the popup was on screen (see
   * IncomingMeetingNotice's onIncomingMeetingDismissed). Absent on web,
   * where clearing the in-page card is just local state, no IPC needed. A
   * no-op on the Electron side too if `callId` is not the invite currently
   * open (main/meeting-invite-manager.ts's dismiss()).
   */
  dismissMeetingInvitePopup?: (callId: string) => void;
  /** Present only in Electron: pin a task to the desktop as an always-on-top
   *  sticky note. Tasks already pin themselves when they arrive; this is used
   *  when one is acknowledged. Resolves with the authoritative pinned set
   *  (+ refusal reason — including "unpinned" for a task the user explicitly
   *  unpinned, which is never re-pinned). Absent on web (no persistent desktop
   *  window exists). */
  pinTask?: (taskId: string) => Promise<PinResult>;
  /** Present only in Electron: the task ids currently pinned to the desktop
   *  (source of truth = main process). Drives the in-app lock on acknowledged
   *  pinned tasks. */
  listPinned?: () => Promise<string[]>;
  // NOTE: there is deliberately no `unpinTask`/`dismissSticky` here. One existed,
  // and the app called it whenever a task was OPENED, which permanently retired
  // that task's desktop note while the task was still outstanding. Unpinning is
  // the note's own business — its Unpin button sends "sticky:unpin" straight
  // from the note window (see apps/desktop/src/preload/sticky.ts). Nothing in
  // the app should be able to clear someone's note.
  /** Forward the current access token to the host (Electron → utilityProcess). */
  persistToken?: (token: string | null) => void;
  /** Present only in Electron: pin a DM thread to the desktop as a standalone
   *  always-available chat window. Absent on web, where PinButton renders null.
   *  Lives here rather than on `window` so the renderer and the desktop preload
   *  are typechecked against ONE definition. */
  chatSticky?: ChatStickyHost;
  /** Present only in Electron: the refresh token, read from the host's cookie
   *  jar / OS-encrypted store.
   *
   *  The packaged renderer loads from file://, so requests to the API origin are
   *  cross-site and Chromium will not attach the SameSite=lax refresh cookie —
   *  the token has to travel in the /auth/refresh body instead. Web leaves this
   *  undefined and keeps using the cookie, which is strictly safer. */
  getRefreshToken?: () => Promise<string | null>;
  /** Present only in Electron: mirror the refresh token to the host's encrypted
   *  store, or clear it (null) on logout so the session can't be resurrected. */
  persistRefreshToken?: (token: string | null) => void;
  /** Present only in Electron: the installed app's version (e.g. "0.1.42").
   *  Shown in Settings → About. A desktop build can sit far behind the web app
   *  with nothing on screen to say so — which is how "the desktop app is
   *  missing features" happens — so the running version has to be visible. */
  appVersion?: () => Promise<string>;
  /** Present only in Electron: check the update feed on demand. The automatic
   *  launch check stays silent when it finds nothing, which is right for a
   *  background task and useless for a user asking "am I up to date?". */
  checkForUpdates?: () => Promise<{
    status: "checking" | "available" | "up-to-date" | "downloading" | "unsupported" | "error";
    version?: string;
    message?: string;
  }>;
  /** Present only in Electron: fires if a download that checkForUpdates()
   *  kicked off later fails in the background. checkForUpdates() already
   *  resolved "downloading" by then and told the user to expect a restart
   *  prompt — this is the only way a subsequent failure can still reach the
   *  UI, so it doesn't look like the download is silently stuck forever. */
  onUpdateCheckFailed?: (cb: (message: string) => void) => () => void;
  /** Present only in Electron: mirrors the "Desktop notifications" preference
   *  (packages/app/src/lib/notificationPrefs.ts's localStorage copy) to the
   *  main process, which raises OS popups for messages/tasks/calls on its own
   *  — see apps/desktop/src/main/notifier.ts — and has no access to the
   *  renderer's localStorage to check the preference itself. Absent on web,
   *  where the localStorage copy IS the notification path (lib/callNotify.ts
   *  reads it directly, no IPC involved). */
  notificationPrefs?: {
    getDesktopEnabled: () => Promise<boolean>;
    setDesktopEnabled: (enabled: boolean) => Promise<void>;
  };
  /** Present only in Electron: mirrors the effective UI language to the main
   *  process, which owns the application menu, the tray and OS notifications and
   *  has no access to this renderer's localStorage (same reason as
   *  `notificationPrefs`). Called whenever the active language is applied —
   *  see i18n/LanguageProvider.tsx. Absent on web. */
  localePrefs?: {
    setLocale: (locale: string) => Promise<void>;
  };
  /** Present only in Electron: open (or focus, if already open) a meeting in
   *  its own OS window instead of rendering it as an overlay in this one —
   *  see lib/MeetingSession.tsx's `enter()`, which calls this when present
   *  and never touches its own local overlay state on Electron. Absent on
   *  web, where `enter()` keeps rendering the room in-page as it always has. */
  openMeetingWindow?: (callId: string) => void;
  /** Present only on the SECONDARY Electron meeting window `openMeetingWindow`
   *  creates: its credential-bearing IPC channels (auth:refresh-token, etc.)
   *  are gated to the main window only (see fromMainWindow in
   *  apps/desktop/src/main/index.ts) — a deliberate boundary this does not
   *  widen. So SessionBootstrap must instead wait for the main window to
   *  mirror its session over lib/authChannel.ts's BroadcastChannel (same
   *  mechanism that already syncs sessions between web tabs) before
   *  attempting its own refresh. Absent everywhere else. */
  bootstrapFromPeerSession?: boolean;
  /** Present only in Electron: push this meeting's live status to the main
   *  window's status pill (features/MeetingWindowStatusBar.tsx) — called
   *  from the meeting window's own CallRoom whenever title/mic/cam/
   *  participant count changes. No video: LiveKit Track objects live in the
   *  meeting window's own renderer process and cannot cross to this one. */
  pushMeetingWindowStatus?: (status: MeetingWindowStatus) => void;
  /** Present only in Electron, on the main window: subscribe to the status
   *  above. Returns an unsubscribe fn. */
  onMeetingWindowStatus?: (cb: (status: MeetingWindowStatus) => void) => () => void;
  /** Present only in Electron, on the main window: a meeting window closed —
   *  gracefully or not — so the status pill can clear itself even without a
   *  final status push (a crash, or the window closing while unfocused). */
  onMeetingWindowClosed?: (cb: (callId: string) => void) => () => void;
  /** Present only in Electron, on the main window: the status pill's hang-up
   *  button. Round-trips to the window that actually owns the live LiveKit
   *  room (same close handshake the OS close button uses) rather than
   *  leaving the call from here directly, which would update the server
   *  roster without ever disconnecting LiveKit or releasing the camera/mic. */
  hangUpMeetingWindow?: (callId: string) => void;
  /** Present only in Electron: open a URL in the user's DEFAULT browser.
   *  Google refuses OAuth inside an embedded webview (`disallowed_useragent`),
   *  so the authorize URL must leave the app entirely. Absent on web, where a
   *  same-tab redirect works and is what users expect. */
  openExternal?: (url: string) => void;
  /** Present only in Electron: fetch a signed, non-previewable mail attachment
   *  URL in the MAIN process and open the FILE with the OS's native default
   *  app (shell.openPath), instead of routing a target="_blank" click through
   *  the system browser. Absent on web, where target="_blank" is the only —
   *  and correct — option. See apps/desktop/src/main/attachment-open.ts. */
  openAttachment?: (url: string, fileName: string) => Promise<{ ok: boolean; error?: string }>;
  /** Present only in Electron: whether this build can resolve a PRECISE
   *  location. Chromium's network locator needs a Google API key Electron does
   *  not ship (see main/geo-key.ts), and Linux has no OS locator to fall back
   *  on — so a keyless build can only ever return the server's city-level IP
   *  fix. Absent on web, where the browser owns the provider and the question
   *  is not ours to answer. */
  hasPreciseLocation?: () => Promise<boolean>;
  /** Open the OS page where location access for desktop apps is granted.
   *
   *  Present ONLY where such a page exists — Electron on Windows and macOS.
   *  Absent on web (the browser's own prompt is the grant) and on Linux, which
   *  has no OS location provider to authorize. Treat its presence as the
   *  capability check and render nothing when it is missing: an "open settings"
   *  button that opens nothing is worse than no button.
   *
   *  Resolves false if the host declined to open anything. Takes no URL — the
   *  host owns it, deliberately (see desktop shared/location-settings.ts). */
  openLocationSettings?: () => Promise<boolean>;
  /** Present only in Electron: the OS page where camera/microphone access for
   *  desktop apps is granted, one per media kind.
   *
   *  Present ONLY where such a page exists (Windows and macOS — see
   *  desktop/shared/media-settings.ts, which mirrors openLocationSettings'
   *  own reasoning exactly). Absent on web and on Linux, which has no such
   *  page; render nothing rather than a button that opens nothing.
   *
   *  Resolves false if the host declined to open anything. Takes no URL —
   *  the host owns it, deliberately, same as openLocationSettings. */
  openCameraSettings?: () => Promise<boolean>;
  openMicrophoneSettings?: () => Promise<boolean>;
  /** Present only in Electron: the app is about to quit.
   *
   *  Neither a hang-up click nor a React unmount is coming — the process can
   *  be torn down before either runs — so this is the renderer's one chance
   *  to disconnect an active meeting's room, tell the server the user left,
   *  and clear its "resume this meeting" marker before that happens. Main
   *  PAUSES the quit briefly to give this a chance to finish; call
   *  notifyQuitReady() once done (or immediately if there is nothing to do)
   *  so the quit does not wait out the full safety timeout for no reason.
   *  Returns an unsubscribe fn. Absent on web, where there is no process to
   *  quit out from under the page. */
  onBeforeQuit?: (cb: () => void) => () => void;
  notifyQuitReady?: () => void;
  /** Present only in Electron, and only meaningful in a meeting window (see
   *  main/meeting-window-manager.ts): THIS window is about to close — the OS
   *  close button, or the main window's status-pill hang-up button — while
   *  the app itself keeps running. Distinct from onBeforeQuit: the app is
   *  not exiting, only this window is, but the reason to pause it is the
   *  same — give CallRoom one chance to disconnect the room and tell the
   *  server the user left before the window is actually destroyed. Call
   *  notifyWindowCloseReady() once done. Returns an unsubscribe fn. */
  onBeforeWindowClose?: (cb: () => void) => () => void;
  notifyWindowCloseReady?: () => void;
  /** Present only in Electron: the app detected and refused a screenshot
   *  attempt.
   *
   *  `chord` names what was pressed, and `recorded` says whether main has
    *  ALREADY written the attempt to the activity record, so the renderer must
    *  not report it a second time. `route` is the originating window's
    *  normalized app route when it can be determined.
   *
   *  Its ABSENCE is the capability check the web build depends on: no desktop
   *  host means the page installs its own key watcher instead (lib/screenGuard).
   *  Returns an unsubscribe fn. */
  onScreenshotBlocked?: (
    cb: (info: { chord: string; recorded: boolean; route?: string }) => void,
  ) => () => void;
}

/** Retained for the index re-export; Electron sticky widgets are owned by main. */
export type StickyBridge = EventSource;
