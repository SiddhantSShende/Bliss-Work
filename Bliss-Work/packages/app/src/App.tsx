import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import { NOTIFICATION_MESSAGE_PARAM, validUuid } from "./lib/notificationDestination";
import { Toaster } from "sonner";
import { ThemeProvider } from "@taskboard/ui";
import type { PlatformConfig } from "./platform";
import { RuntimeProvider, useRuntime } from "./lib/runtime";
import { ThemeSync, publishThemePrefs } from "./lib/themeSync";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { queryRetryDelay, shouldRetryQuery } from "./lib/retryPolicy";
import { FileTransferProvider } from "./lib/fileTransfer";
import { useSession } from "./store/session";
import { refreshSession } from "./lib/refresh";
import { installGlobalErrorHandlers } from "./lib/globalErrorHandlers";
import { installAuthChannel, requestSession } from "./lib/authChannel";
import { clearCacheOnIdentityChange } from "./lib/clearCacheOnIdentityChange";
import { withLoadTimeout } from "./lib/withLoadTimeout";
import { reloadForStaleChunk } from "./lib/chunkReloadRecovery";
import { legacyInboxTarget } from "./lib/mailView";
import { SelectedChatProvider, useSelectedChat } from "./lib/selectedChat";
import { useTranslation } from "react-i18next";
import { MessageSquare, Hash, Users } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import { ErrorBoundary, RouteErrorBoundary } from "./features/ErrorBoundary";
import { BrowserStickies } from "./features/BrowserStickies";
import { DesktopDragStrip } from "./features/DesktopDragStrip";
import { MeetingHost } from "./features/MeetingHost";
import { MeetingSessionProvider } from "./lib/MeetingSession";
import { ScreenshotNotice } from "./features/ScreenshotNotice";
import { MeetingWindowStatusBar } from "./features/MeetingWindowStatusBar";
import { RequireAuth } from "./lib/RequireAuth";
// ── Route loading: eager for signed-out, lazy for everything behind the login ─
//
// Every route used to be a static import, which put all thirty of them plus the
// video-call stack into ONE 1.45 MB entry chunk. A visitor downloaded and
// parsed the entire product to reach a login form.
//
// (INFRASTRUCTURE.md used to claim "the Vite build already splits by route." It
// did not — there was exactly one dynamic import in the whole application, for
// the Excel export. That claim is why this was never looked at.)
//
// The split is drawn at authentication, not by size:
//
//   EAGER — the signed-out surface. These ARE the critical path: a visitor
//   needs one of them before anything else can happen, so making them lazy
//   would add a network round trip to the very screen this change exists to
//   make faster. Together they are small (forms and copy).
//
//   LAZY — everything behind RequireAuth, plus /join. Nobody reaches most of
//   these without a session, by which point the shell can prefetch in the
//   background. /join is the one exception with a signed-out surface of its
//   own (the desktop-handoff landing page) — it stays lazy anyway since a
//   meeting link is still reached far less often than the routes above.
//   Splitting here is what removes the call stack, the charts and the task
//   board from first paint.
import { Onboarding } from "./routes/Onboarding";
import { Login } from "./routes/Login";
import { InviteAccept } from "./routes/InviteAccept";
import { ForgotPassword } from "./routes/ForgotPassword";
import { ResetPassword } from "./routes/ResetPassword";
import { VerifyEmail } from "./routes/VerifyEmail";
import { MfaChallenge } from "./routes/MfaChallenge";

// AppShell is separate from the routes it frames: it is needed by EVERY
// authenticated route, so it belongs in the app-core chunk rather than being
// duplicated into each one. Rollup does that automatically once it is a shared
// dependency of several dynamic imports.
const AppShell = lazyRoute(() => import("./routes/AppShell"), "AppShell");
const DMView = lazyRoute(() => import("./routes/DMView"), "DMView");
const ChannelView = lazyRoute(() => import("./routes/ChannelView"), "ChannelView");
const MemberDetail = lazyRoute(() => import("./routes/MemberDetail"), "MemberDetail");
const MyActivity = lazyRoute(() => import("./routes/MyActivity"), "MyActivity");
const OrgActivity = lazyRoute(() => import("./routes/OrgActivity"), "OrgActivity");
const Tasks = lazyRoute(() => import("./routes/Tasks"), "Tasks");
const ProjectWorkspacePage = lazy(async () => {
  try {
    const module = await withLoadTimeout(
      import("./routes/ProjectWorkspace"),
      ROUTE_CHUNK_TIMEOUT_MS,
      "Timed out loading ProjectWorkspace",
    );
    return { default: module.ProjectWorkspace };
  } catch (error) {
    reloadForStaleChunk();
    throw error;
  }
});

const Search = lazyRoute(() => import("./routes/Search"), "Search");
const InvitePage = lazyRoute(() => import("./routes/InvitePage"), "InvitePage");
const Profile = lazyRoute(() => import("./routes/Profile"), "Profile");
const Settings = lazyRoute(() => import("./routes/Settings"), "Settings");
const MfaSettings = lazyRoute(() => import("./routes/MfaSettings"), "MfaSettings");
const ActiveSessions = lazyRoute(() => import("./routes/ActiveSessions"), "ActiveSessions");
const Org = lazyRoute(() => import("./routes/Org"), "Org");
const Analytics = lazyRoute(() => import("./routes/Analytics"), "Analytics");
// The Mail layout owns the message column; the routes below it are what shows
// in the reading pane beside it. Both named exports live in one module, so the
// two wrappers resolve the same chunk.
const MailLayout = lazyRoute(() => import("./routes/MailLayout"), "MailLayout");
const MailWelcome = lazyRoute(() => import("./routes/MailLayout"), "MailWelcome");
const MailThread = lazyRoute(() => import("./routes/MailThread"), "MailThread");
const MailTask = lazyRoute(() => import("./routes/MailTask"), "MailTask");
const MailDetail = lazyRoute(() => import("./routes/MailDetail"), "MailDetail");
const MailCompose = lazyRoute(() => import("./routes/MailCompose"), "MailCompose");
const MeetingsLayout = lazyRoute(() => import("./routes/MeetingsLayout"), "MeetingsLayout");
const MeetingsCalendar = lazyRoute(() => import("./routes/MeetingsCalendar"), "MeetingsCalendar");
const MeetingDetail = lazyRoute(() => import("./routes/MeetingDetail"), "MeetingDetail");
const JoinCallView = lazyRoute(() => import("./routes/JoinCallView"), "JoinCallView");
const CallWindow = lazyRoute(() => import("./routes/CallWindow"), "CallWindow");

/**
 * `React.lazy` for a NAMED export.
 *
 * Every route in this app is a named export, and React.lazy resolves a module's
 * `default` — so each one needs the same `.then(m => ({ default: m.X }))`
 * adapter. Writing it eighteen times invites exactly one typo, and a typo here
 * fails at RUNTIME on navigation ("Element type is invalid") rather than at
 * build time, because the module shape is only inspected once the chunk loads.
 *
 * Taking the export name as a string keeps that adapter in one place. It is
 * still checked: the `Record<string, ComponentType<P>>` constraint means a name
 * that is not a component export of that module is a type error.
 *
 * Chunk naming is left to Rollup, which derives it from the module path — so
 * `Settings.tsx` becomes `Settings-<hash>.js` and a waterfall is readable
 * without a source map.
 */
/**
 * How long a route chunk gets before this gives up waiting and self-heals,
 * same budget as CallRoomLazy.tsx's identical constant for the meeting room's
 * own chunk. See withLoadTimeout's doc for why a hard refresh is exactly the
 * moment a chunk fetch is most likely to stall rather than merely take a
 * while.
 */
const ROUTE_CHUNK_TIMEOUT_MS = 15_000;

function lazyRoute<P extends object, K extends string>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(async () => {
    try {
      const mod = await withLoadTimeout(load(), ROUTE_CHUNK_TIMEOUT_MS, `Timed out loading ${name}`);
      return { default: mod[name] };
    } catch (e) {
      // A route chunk that stalls or fails gets the SAME recovery as a stale
      // deploy (chunkReloadRecovery.ts's vite:preloadError handler): reload
      // once, then stop — there is no active call/session on this surface to
      // disrupt (nothing has rendered yet), unlike CallRoomLazy, which offers
      // a manual button instead precisely because it can be catching a
      // runtime error from an ALREADY-CONNECTED call. Still throws either
      // way, so RouteErrorBoundary has something to show for the moment
      // before a triggered reload actually takes effect, and for the
      // loop-guarded case where reloadForStaleChunk did nothing.
      reloadForStaleChunk();
      throw e;
    }
  });
}

/**
 * Shown while a route chunk is in flight.
 *
 * Deliberately blank rather than a spinner. These chunks are small and served
 * with a long cache lifetime, so on everything but the first visit to a route
 * the fallback is on screen for a frame or two — long enough for a spinner to
 * flash, not long enough for it to inform. An empty box on the app background
 * reads as the page painting; a flashing spinner reads as jank.
 */
function RouteFallback() {
  return <div className="h-full w-full bg-bg" aria-busy="true" />;
}

// Install once at module load — both guard against double-install in StrictMode
// / Fast Refresh. installAuthChannel mirrors session/login/logout across tabs.
installGlobalErrorHandlers();
installAuthChannel();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // Transport failures get a ~15s budget, HTTP failures a short one — see
      // lib/retryPolicy for why the two differ.
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    },
    mutations: {
      // Idempotency is server-side; never auto-retry a write blindly.
      retry: 0,
    },
  },
});

// The cache is keyed by nothing that says whose it is — see the module.
clearCacheOnIdentityChange(queryClient);

export type { PlatformConfig } from "./platform";
export type { StickyBridge } from "./platform";

export function App({ config }: { config: PlatformConfig }) {
  const Router = config.router === "hash" ? HashRouter : BrowserRouter;
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider config={config}>
          {/* Unlike ThemeProvider below, this has no per-route forced value
              (nothing forces Login/Onboarding to a fixed language the way
              they force the default theme), so it wraps here rather than
              waiting for <Router>. */}
          <LanguageProvider>
          <FileTransferProvider>
            <Router>
              {/* ThemeProvider lives HERE, inside <Router>, rather than
                  wrapping it — see ThemedTree below for why: it needs
                  useLocation() to decide whether the current screen is
                  forced to the default theme (Login/Signup), and that hook
                  only works inside a Router. Nothing outside this point
                  (Toaster, ScreenshotNotice, the other bridges below) reads
                  useTheme(), so moving it here costs them nothing. */}
              <ThemedTree>
              {/* Inside <Router> because minimising a meeting opened in its own
                  tab navigates into the app — there is nothing behind the
                  floating window at /call/:id otherwise. */}
              <MeetingSessionProvider>
              <SessionBootstrap config={config}>
                <RouteErrorBoundary>
                {/* INSIDE RouteErrorBoundary, deliberately. A lazy chunk that
                    fails to load (a stale index.html pointing at assets a
                    deploy has replaced) throws during render, and the boundary
                    has to be above the Suspense to catch it — otherwise the
                    failure escapes to the app-level ErrorBoundary and blanks
                    the whole application instead of the one route.
                    lib/chunkReloadRecovery handles the stale-deploy case. */}
                <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/onboarding" element={<Onboarding />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/invite" element={<InviteAccept />} />
                  <Route path="/forgot-password" element={<ForgotPassword />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="/verify-email" element={<VerifyEmail />} />
                  {/* Reached from /login (and org-switch) when a second factor
                      is still owed — carries its pendingToken only in router
                      state, never the URL. */}
                  <Route path="/mfa-challenge" element={<MfaChallenge />} />
                  {/* Meeting invite links land here, OUTSIDE /app so someone
                      in another organisation is not bounced through an app
                      shell scoped to an org they do not belong to. Auth-gating
                      lives INSIDE JoinCallView itself (via RequireAuth) rather
                      than at the route level like everything else below —
                      redeeming still requires a real account, but a signed-out
                      visitor first needs to see the desktop-app-handoff
                      landing page, which a route-level RequireAuth would
                      redirect away from before it could ever render. */}
                  <Route path="/join" element={<JoinCallView />} />
                  {/* A meeting, in a tab of its own (lib/callWindow). Outside
                      /app deliberately: the room IS the window, and the app
                      shell's sidebar beside a video grid helps nobody. Still
                      gated — the room needs a session to mint its token. */}
                  <Route
                    path="/call/:callId"
                    element={
                      <RequireAuth>
                        <CallWindow />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/app"
                    element={
                      <RequireAuth>
                        {/* OUTSIDE AppShell, not inside it: the shell reads the
                            selection too (a chat being open is what makes the
                            phone layout show the conversation instead of the
                            list), and a component cannot consume a context it
                            is itself providing. */}
                        <SelectedChatProvider>
                          <AppShell />
                        </SelectedChatProvider>
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Navigate to="/app/analytics" replace />} />
                    {/* Mail is a LAYOUT, not a page: MailLayout renders the
                        message column itself and puts whatever was opened from
                        it in the pane beside it. Every route below is therefore
                        a child — opening a mail must not throw away the list it
                        was picked out of. Which folder and which person the
                        list is narrowed to ride in the query string (?box=, ?p=)
                        so both panes read the same filters; see lib/mailView.
                        The folder column itself is a level up, in AppShell. */}
                    <Route path="mail" element={<MailLayout />}>
                      {/* Nothing opened yet — from xl up the pane holds an empty
                          state beside the list; below xl the list has it all. */}
                      <Route index element={<MailWelcome />} />
                      <Route path="all" element={<MailWelcome />} />
                      <Route path="thread/:threadId" element={<MailThread />} />
                      <Route path="message/:mailId" element={<MailDetail />} />
                      {/* The composer takes the SAME pane a mail is read in, so
                          New Mail and opening a mail are the same gesture. */}
                      <Route path="compose" element={<MailCompose />} />
                      {/* Resuming an unsent mail from the Drafts folder. The
                          SAME component: a draft is not a different kind of
                          thing from a mail being written, it is one that was
                          left and picked up again. */}
                      <Route path="compose/:draftId" element={<MailCompose />} />
                      {/* Tasks no longer appear in the mail list (they live in
                          Tasks), but this route stays: existing deep links and
                          notification targets still resolve to it. */}
                      <Route path="task/:taskId" element={<MailTask />} />
                    </Route>
                    {/* Everything this section was called before Mail. */}
                    <Route path="inbox/*" element={<LegacyInboxRedirect />} />
                    {/* Meetings is a LAYOUT holding two views that take turns in
                        one full-width pane: the calendar, and one meeting in
                        full. It no longer asks the shell for a list pane — the
                        Upcoming / Live / Past column that used to live there is
                        the tab strip under the calendar (see lib/section).

                        Which week, which scale and which tab all ride in the
                        search string (?d= ?scale= ?view=), so opening a meeting
                        and coming back returns to exactly the view it was picked
                        out of. See lib/meetingCalendar and lib/meetingView. */}
                    <Route path="meetings" element={<MeetingsLayout />}>
                      <Route index element={<MeetingsCalendar />} />
                      {/* The path every "back to the list" link has always
                          pointed at. Kept, so bookmarks and the detail's own way
                          out still resolve. */}
                      <Route path="all" element={<MeetingsCalendar />} />
                      <Route path=":callId" element={<MeetingDetail />} />
                    </Route>
                    {/* ONE route for the whole section. Which conversation is
                        open is held in memory (lib/selectedChat) rather than in
                        the path, so a private chat's UUID never reaches the
                        address bar, the history entry or the referrer. */}
                    <Route path="chats" element={<ChatsPane />} />
                    {/* Kept for links minted before that changed — bookmarks,
                        notification targets, a URL someone pasted to
                        themselves. It opens the chat and replaces itself, so
                        the id is gone from the bar and from history by the time
                        anything renders. */}
                    <Route path="chats/:conversationId" element={<ChatDeepLink />} />
                    <Route path="channels" element={<ChannelsEmpty />} />
                    <Route path="channels/:channelId" element={<ChannelView />} />
                    <Route path="members" element={<MembersEmpty />} />
                    <Route path="members/activity" element={<OrgActivity />} />
                    <Route path="members/:userId" element={<MemberDetail />} />
                    <Route path="tasks" element={<Navigate to="/app/tasks/allocated" replace />} />
                    <Route path="tasks/projects/:projectId" element={<ProjectWorkspacePage />} />
                    <Route path="tasks/:view" element={<Tasks />} />
                    <Route path="search" element={<Search />} />
                    <Route
                      path="invite"
                      element={config.kind === "electron" ? <Navigate to="/app/mail" replace /> : <InvitePage />}
                    />
                    <Route path="profile" element={<Profile />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="settings/activity" element={<MyActivity />} />
                    <Route path="settings/security" element={<MfaSettings />} />
                    <Route path="settings/sessions" element={<ActiveSessions />} />
                    <Route path="org" element={<Org />} />
                    <Route path="analytics" element={<Analytics />} />
                    <Route path="analytics/projects/:projectId" element={<Analytics />} />
                    <Route path="analytics/:channelId" element={<Analytics />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/app" replace />} />
                </Routes>
                </Suspense>
                </RouteErrorBoundary>
              </SessionBootstrap>
              {/* Browser-only floating sticky notes — float across every
                  authenticated /app/* route (gated inside BrowserStickies) so a
                  newly-assigned task pops wherever the user is. Mounted inside
                  <Router> so it can read the current location. Electron uses real
                  desktop windows instead. */}
              <BrowserStickies />
              {/* Desktop only: drag handle for screens that have no app-shell header. */}
              <DesktopDragStrip />
              {/* The meeting, mounted ABOVE the routes so navigating cannot
                  unmount it — which is what used to hang up the call. Routes
                  ask for a meeting via useMeetingSession().enter(); none of
                  them render the room themselves any more. */}
              <MeetingHost />
              </MeetingSessionProvider>
              </ThemedTree>
            </Router>
            </FileTransferProvider>
            </LanguageProvider>
            <Toaster position="bottom-right" richColors closeButton />
            {/* Renders nothing; turns a main-process screenshot detection into
                a toast. Inert on web. Must sit inside RuntimeProvider (it reads
                the platform config) and alongside the Toaster it drives. */}
            <ScreenshotNotice />
            {/* Renders a pill only while a meeting is running in its own
                window (main/meeting-window-manager.ts) — title, elapsed
                time, mic state, hang-up. Renders nothing on web or when no
                meeting is open. Outside <Router> like ScreenshotNotice, for
                the same reason: it needs no route, just RuntimeProvider. */}
            <MeetingWindowStatusBar />
          </RuntimeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

/** Routes that retain a default-theme override even if an authenticated user
 *  visits them. Before auth is confirmed, every route uses the default theme:
 *  the startup scripts paint it and ThemeProvider gates persisted preferences
 *  on session status. */
const FORCED_DEFAULT_THEME_PATHS = new Set(["/login", "/onboarding"]);

/**
 * Where ThemeProvider actually lives — inside <Router>, not wrapping it —
 * so it can combine the confirmed session state with a route-specific default
 * override. The provider stays route-agnostic; this is the one place that
 * knows both the current route and app auth state.
 */
function ThemedTree({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const { api } = useRuntime();
  const authenticated = useSession((s) => s.status === "authed");
  const accountId = useSession((s) => s.user?.id);
  return (
    // ThemeSync mirrors the whole theme document (preset, light/dark, Custom
    // activation, and the palette) to the account.
    <ThemeProvider
      authenticated={authenticated}
      accountId={accountId}
      forceDefault={!authenticated || FORCED_DEFAULT_THEME_PATHS.has(pathname)}
      onPrefsChange={(prefs) => publishThemePrefs(api, prefs, { notify: true })}
    >
      <ThemeSync />
      {children}
    </ThemeProvider>
  );
}

/** On load, try to restore a session via the refresh cookie. */
function SessionBootstrap({
  config,
  children,
}: {
  config: PlatformConfig;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  const status = useSession((s) => s.status);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // The Electron meeting window's own credential IPC is deliberately
      // gated to the main window only (see fromMainWindow in
      // apps/desktop/src/main/index.ts) — so before asking the server for
      // anything, wait for the main window to mirror its already-live
      // session over the BroadcastChannel. This settles BEFORE
      // refreshSession runs, which is what lets its own getRecentSession()
      // check (lib/refresh.ts) find it instead of racing it and rotating
      // the shared refresh token a second time.
      if (config.bootstrapFromPeerSession) await requestSession();
      // Single-flight: dedupes the StrictMode double-invoke so the rotating
      // refresh token isn't consumed twice (which would revoke the session).
      const s = await refreshSession(config.authBase, config.persistToken, config.getRefreshToken);
      if (!s) useSession.getState().clear();
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready || status === "loading")
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-muted)]">
        {t("loading")}
      </div>
    );
  return <>{children}</>;
}

/**
 * Everything /app/inbox used to address, pointed at /app/mail.
 *
 * The mapping itself is a pure function in lib/mailView — a redirect that
 * silently drops a segment is invisible until somebody follows a two-year-old
 * link, which is exactly the kind of thing worth having a test for.
 */
function LegacyInboxRedirect() {
  const { search } = useLocation();
  // "*" is the whole tail of /app/inbox/…, which is what this has to re-point.
  return <Navigate to={legacyInboxTarget(useParams()["*"] ?? "", search)} replace />;
}

/**
 * The chats pane: the open conversation, or the welcome state when there is
 * none.
 *
 * This is the whole of what the `/app/chats/:conversationId` route used to do,
 * moved off the URL — the selection is read from memory instead of from a path
 * param. Nothing else about DMView changes: it is the same component, mounted
 * in the same place, keyed so that switching chats remounts it exactly as a
 * route change used to.
 */
function ChatsPane() {
  const { selectedId } = useSelectedChat();
  if (!selectedId) return <ChatsEmpty />;
  // NOT keyed on the id. React Router reused this component across a change of
  // :conversationId rather than remounting it, which is why DMView carries its
  // own reset effects for the reply draft, the search box and the staged
  // attachments. Keying it here would remount instead — a different behaviour
  // that would quietly make those effects dead code.
  return <DMView />;
}

/**
 * A `/app/chats/:conversationId` link, opened and then erased.
 *
 * `openChat(..., { replace: true })` does both halves in one go: it records the
 * selection and REPLACES this entry with `/app/chats`, so the id leaves the
 * address bar and leaves history rather than sitting one Back press away.
 */
function ChatDeepLink() {
  const { conversationId = "" } = useParams();
  const { openChat } = useSelectedChat();
  // A notification link may carry the message to land on (?m=); like the id it is
  // handed to the in-memory selection and leaves the URL with the replace below.
  const messageId = validUuid(useSearchParams()[0].get(NOTIFICATION_MESSAGE_PARAM)) ?? undefined;
  useEffect(() => {
    if (conversationId) openChat(conversationId, { replace: true, messageId });
  }, [conversationId, messageId, openChat]);
  // Until the effect runs, this is the same neutral state a reload lands on —
  // never a flash of somebody else's conversation.
  return <ChatsEmpty />;
}

function ChatsEmpty() {
  const { t } = useTranslation("chatList");
  const user = useSession((s) => s.user);
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<MessageSquare size={26} />}
        title={
          user
            ? t("chatsEmpty.welcomeWithName", { name: user.displayName.split(" ")[0] })
            : t("chatsEmpty.welcome")
        }
        hint={t("chatsEmpty.hint")}
      />
    </div>
  );
}

function ChannelsEmpty() {
  const { t } = useTranslation("chatList");
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState icon={<Hash size={26} />} title={t("channelsEmpty.title")} hint={t("channelsEmpty.hint")} />
    </div>
  );
}

function MembersEmpty() {
  const { t } = useTranslation("members");
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState icon={<Users size={26} />} title={t("membersEmpty.title")} hint={t("membersEmpty.hint")} />
    </div>
  );
}
