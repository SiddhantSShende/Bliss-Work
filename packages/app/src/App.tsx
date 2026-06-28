import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "@taskboard/ui";
import { ApiError } from "@taskboard/shared";
import type { PlatformConfig } from "./platform";
import { RuntimeProvider } from "./lib/runtime";
import { FileTransferProvider } from "./lib/fileTransfer";
import { useSession } from "./store/session";
import { refreshSession } from "./lib/refresh";
import { installGlobalErrorHandlers } from "./lib/globalErrorHandlers";
import { installAuthChannel } from "./lib/authChannel";
import { MessageSquare, Hash, Users } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import { ErrorBoundary, RouteErrorBoundary } from "./features/ErrorBoundary";
import { BrowserStickies } from "./features/BrowserStickies";
import { Onboarding } from "./routes/Onboarding";
import { Login } from "./routes/Login";
import { InviteAccept } from "./routes/InviteAccept";
import { AppShell } from "./routes/AppShell";
import { DMView } from "./routes/DMView";
import { ChannelView } from "./routes/ChannelView";
import { Tasks } from "./routes/Tasks";
import { Search } from "./routes/Search";
import { InvitePage } from "./routes/InvitePage";
import { Profile } from "./routes/Profile";
import { Settings } from "./routes/Settings";
import { InboxFeed } from "./routes/InboxFeed";
import { InboxThread } from "./routes/InboxThread";
import { InboxTask } from "./routes/InboxTask";

// Install once at module load — both guard against double-install in StrictMode
// / Fast Refresh. installAuthChannel mirrors session/login/logout across tabs.
installGlobalErrorHandlers();
installAuthChannel();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // Retry only on transient 5xx; 4xx is a real client error.
      retry: (failureCount, error) => {
        if (failureCount >= 2) return false;
        if (error instanceof ApiError) return error.status >= 500;
        return true;
      },
      retryDelay: (attempt) => Math.min(200 * 2 ** attempt, 2_000),
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
                <Routes>
                  <Route path="/onboarding" element={<Onboarding />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/invite" element={<InviteAccept />} />
                  <Route
                    path="/app"
                    element={
                      <Protected>
                        <AppShell />
                      </Protected>
                    }
                  >
                    <Route index element={<Navigate to="/app/inbox" replace />} />
                    <Route path="inbox" element={<InboxFeed />} />
                    <Route path="inbox/all" element={<InboxFeed />} />
                    <Route path="inbox/p/:peerId" element={<InboxFeed />} />
                    <Route path="inbox/thread/:threadId" element={<InboxThread />} />
                    <Route path="inbox/task/:taskId" element={<InboxTask />} />
                    <Route path="chats" element={<ChatsEmpty />} />
                    <Route path="chats/:conversationId" element={<DMView />} />
                    <Route path="channels" element={<ChannelsEmpty />} />
                    <Route path="channels/:channelId" element={<ChannelView />} />
                    <Route path="members" element={<MembersEmpty />} />
                    <Route path="tasks" element={<Navigate to="/app/tasks/allocated" replace />} />
                    <Route path="tasks/:view" element={<Tasks />} />
                    <Route path="search" element={<Search />} />
                    <Route path="invite" element={<InvitePage />} />
                    <Route path="profile" element={<Profile />} />
                    <Route path="settings" element={<Settings />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/app" replace />} />
                </Routes>
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
    refreshSession(config.authBase, config.persistToken).then((s) => {
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
      <EmptyState icon={<Users size={26} />} title="Members" hint="Pick a teammate on the left to start a conversation." />
    </div>
  );
}
