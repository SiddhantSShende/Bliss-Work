import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "@taskboard/ui";
import type { PlatformConfig } from "./platform";
import { RuntimeProvider } from "./lib/runtime";
import { queryRetryDelay, shouldRetryQuery } from "./lib/retryPolicy";
import { FileTransferProvider } from "./lib/fileTransfer";
import { useSession } from "./store/session";
import { refreshSession } from "./lib/refresh";
import { installGlobalErrorHandlers } from "./lib/globalErrorHandlers";
import { installAuthChannel } from "./lib/authChannel";
import { legacyInboxTarget } from "./lib/mailView";
import { MessageSquare, Hash, Users } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import { ErrorBoundary, RouteErrorBoundary } from "./features/ErrorBoundary";
import { BrowserStickies } from "./features/BrowserStickies";
import { ScreenshotNotice } from "./features/ScreenshotNotice";
// ── Route loading: eager for signed-out, lazy for everything behind the login ─
//
// Every route used to be a static import, which put all thirty of them plus the
// video-call stack and the integrations hub into ONE 1.45 MB entry chunk. A
// visitor downloaded and parsed the entire product to reach a login form.
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
//   LAZY — everything behind Protected, plus /join. Nobody reaches these
//   without a session, by which point the shell can prefetch in the
//   background. Splitting here is what removes the call stack, the
//   integrations hub, the charts and the task board from first paint.
import { Onboarding } from "./routes/Onboarding";
import { Login } from "./routes/Login";
import { InviteAccept } from "./routes/InviteAccept";
import { ForgotPassword } from "./routes/ForgotPassword";
import { ResetPassword } from "./routes/ResetPassword";
import { VerifyEmail } from "./routes/VerifyEmail";

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
const Search = lazyRoute(() => import("./routes/Search"), "Search");
const InvitePage = lazyRoute(() => import("./routes/InvitePage"), "InvitePage");
const Profile = lazyRoute(() => import("./routes/Profile"), "Profile");
const Settings = lazyRoute(() => import("./routes/Settings"), "Settings");
const Integrations = lazyRoute(() => import("./routes/Integrations"), "Integrations");
const Org = lazyRoute(() => import("./routes/Org"), "Org");
// The Mail layout owns the message column; the routes below it are what shows
// in the reading pane beside it. Both named exports live in one module, so the
// two wrappers resolve the same chunk.
const MailLayout = lazyRoute(() => import("./routes/MailLayout"), "MailLayout");
const MailWelcome = lazyRoute(() => import("./routes/MailLayout"), "MailWelcome");
const MailThread = lazyRoute(() => import("./routes/MailThread"), "MailThread");
const MailTask = lazyRoute(() => import("./routes/MailTask"), "MailTask");
const MailDetail = lazyRoute(() => import("./routes/MailDetail"), "MailDetail");
const MailCompose = lazyRoute(() => import("./routes/MailCompose"), "MailCompose");
const Meetings = lazyRoute(() => import("./routes/Meetings"), "Meetings");
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
 * `Integrations.tsx` becomes `Integrations-<hash>.js` and a waterfall is
 * readable without a source map.
 */
function lazyRoute<P extends object, K extends string>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
) {
  return lazy(async () => ({ default: (await load())[name] }));
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

export type { PlatformConfig } from "./platform";
export type { StickyBridge } from "./platform";

export function App({ config }: { config: PlatformConfig }) {
  const Router = config.router === "hash" ? HashRouter : BrowserRouter;
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RuntimeProvider config={config}>
            <FileTransferProvider>
            <Router>
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
                  {/* Meeting invite links land here. Wrapped in Protected
                      because redeeming requires a real account — the link is a
                      seat for an authenticated user, not an anonymous guest
                      pass — but it sits OUTSIDE /app so someone in another
                      organisation is not bounced through an app shell scoped to
                      an org they do not belong to. */}
                  <Route
                    path="/join"
                    element={
                      <Protected>
                        <JoinCallView />
                      </Protected>
                    }
                  />
                  {/* A meeting, in a tab of its own (lib/callWindow). Outside
                      /app deliberately: the room IS the window, and the app
                      shell's sidebar beside a video grid helps nobody. Still
                      Protected — the room needs a session to mint its token. */}
                  <Route
                    path="/call/:callId"
                    element={
                      <Protected>
                        <CallWindow />
                      </Protected>
                    }
                  />
                  <Route
                    path="/app"
                    element={
                      <Protected>
                        <AppShell />
                      </Protected>
                    }
                  >
                    <Route index element={<Navigate to="/app/mail" replace />} />
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
                    <Route path="meetings" element={<Meetings />} />
                    <Route path="chats" element={<ChatsEmpty />} />
                    <Route path="chats/:conversationId" element={<DMView />} />
                    <Route path="channels" element={<ChannelsEmpty />} />
                    <Route path="channels/:channelId" element={<ChannelView />} />
                    <Route path="members" element={<MembersEmpty />} />
                    <Route path="members/activity" element={<OrgActivity />} />
                    <Route path="members/:userId" element={<MemberDetail />} />
                    <Route path="tasks" element={<Navigate to="/app/tasks/allocated" replace />} />
                    <Route path="tasks/:view" element={<Tasks />} />
                    <Route path="search" element={<Search />} />
                    <Route path="invite" element={<InvitePage />} />
                    <Route path="profile" element={<Profile />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="settings/activity" element={<MyActivity />} />
                    <Route path="integrations" element={<Integrations />} />
                    <Route path="org" element={<Org />} />
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
            </Router>
            </FileTransferProvider>
            <Toaster position="bottom-right" richColors closeButton />
            {/* Renders nothing; turns a main-process screenshot detection into
                a toast. Inert on web. Must sit inside RuntimeProvider (it reads
                the platform config) and alongside the Toaster it drives. */}
            <ScreenshotNotice />
          </RuntimeProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
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
  const status = useSession((s) => s.status);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    // Single-flight: dedupes the StrictMode double-invoke so the rotating
    // refresh token isn't consumed twice (which would revoke the session).
    refreshSession(config.authBase, config.persistToken, config.getRefreshToken).then((s) => {
      if (!s) useSession.getState().clear();
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready || status === "loading")
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-muted)]">
        Loading…
      </div>
    );
  return <>{children}</>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  if (status !== "authed") return <Navigate to="/login" replace />;
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

function ChatsEmpty() {
  const user = useSession((s) => s.user);
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<MessageSquare size={26} />}
        title={`Welcome${user ? `, ${user.displayName.split(" ")[0]}` : ""} 👋`}
        hint="Select a chat on the left, or tap + to start a new conversation."
      />
    </div>
  );
}

function ChannelsEmpty() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState icon={<Hash size={26} />} title="Channels" hint="Pick a channel on the left, or tap + to create one." />
    </div>
  );
}

function MembersEmpty() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState icon={<Users size={26} />} title="Members" hint="Pick a teammate on the left to see their profile, or tap the chat icon to message them." />
    </div>
  );
}
