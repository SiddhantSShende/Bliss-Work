import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@taskboard/app/lib/runtime';
import { clearCacheOnIdentityChange } from '@taskboard/app/lib/clearCacheOnIdentityChange';
import { isSessionDead, refreshSession } from '@taskboard/app/lib/refresh';
import { queryRetryDelay, shouldRetryQuery } from '@taskboard/app/lib/retryPolicy';
import { useSession } from '@taskboard/app/store/session';
import type { PlatformConfig } from '@taskboard/app/platform';
import { resolveEndpoints } from '../constants/endpoints';
import { FORCE_PROD_BACKEND } from '../constants/localBackendOverride';
import { ThemeProvider, useThemeColors } from '../theme/ThemeProvider';
import { CallProvider } from '../calls/CallProvider';
import { getRefreshToken, initAuthCookie, persistRefreshToken, syncRefreshTokenFromJar } from '../services/authCookie';
import { usePushRegistration } from '../hooks/usePushRegistration';
import { shouldRetrySessionBootstrap, sessionBootstrapRetryDelay } from './sessionBootstrapPolicy';

// Same retry/staleness tuning apps/web and apps/desktop both use (see
// packages/app/src/lib/retryPolicy.ts's own doc comment for why transport
// failures and HTTP failures get different budgets) — reused rather than
// re-tuned from scratch, since mobile's network conditions (Wi-Fi/cellular
// handoffs) are the exact case that tuning already accounts for.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    },
    mutations: { retry: 0 },
  },
});
// Sign-out, a different user signing in, or an org switch must not leave the
// previous session's cached chats, tasks and mail to be the next one's first paint.
clearCacheOnIdentityChange(queryClient);

// devEndpoints()'s "localhost"/"10.0.2.2" defaults (constants/endpoints.ts)
// only resolve on an emulator/simulator running on the SAME machine as the
// backend — meaningless on a real phone or iPhone. Testing on a physical
// device therefore needs either the always-reachable production backend (no
// networking setup at all) or a local docker-compose stack on the same LAN,
// reached via that machine's real IP through resolveEndpoints's `overrides`
// param.
//
// This used to be a hardcoded `true` here, which meant EVERY build —
// including an ordinary `__DEV__` build on an emulator meant to hit a local
// docker-compose stack — silently talked to the real production backend
// (real login attempts, real MFA/captcha) unless a developer happened to
// notice this line and flip it back. It now defaults to `false`, read from
// the committed `src/constants/localBackendOverride.ts`: a physical-device
// tester flips that file's export to `true` locally and doesn't commit the
// change (see that file, and .gitignore's note, for why it's a committed
// default rather than a gitignored override — Metro resolves every
// `require`/`import` statically while building the bundle, before any code
// runs, so a conditionally-absent module doesn't gracefully fall back to
// `false` here, it fails the whole bundle build for every other checkout).
const endpoints = resolveEndpoints(FORCE_PROD_BACKEND || !__DEV__, Platform.OS === 'ios' ? 'ios' : 'android');
initAuthCookie(endpoints.authBase);

const config: PlatformConfig = {
  kind: 'mobile',
  // Same derivation apps/desktop/src/renderer/main.tsx uses for the
  // identical reason: authBase always shares an origin with the public web
  // app (see constants/endpoints.ts's PROD_ORIGIN), and that origin — not
  // anything mobile-specific — is what a meeting-join link must be built
  // from (lib/meetingDeepLink.ts).
  webBaseUrl: new URL(endpoints.authBase).origin,
  ...endpoints,
  // Unused on mobile: App.tsx's own `config.router === "hash"` check picks a
  // react-router-dom Router, which this app doesn't use — React Navigation
  // drives navigation instead (see navigation/RootNavigator.tsx). The only
  // other reader, lib/callWindow.ts's openCallTab, returns early on
  // `config.kind !== "web"` before ever consulting it. Required as a
  // non-optional field regardless, so this is a harmless placeholder.
  router: 'hash',
  getRefreshToken,
  persistRefreshToken,
  // Repurposed: PlatformConfig.persistToken's documented job (forwarding the
  // access token to a privileged host process) has no mobile equivalent —
  // there is no host process here, the token lives only in the Zustand
  // store, same as web. But lib/refresh.ts's performRefresh() calls this at
  // EXACTLY the moment a successful /auth/refresh has just rotated the
  // refresh cookie, and it's the only hook refresh.ts offers into that event
  // without modifying shared code — so this triggers the native-jar →
  // Keychain mirror sync instead, covering every refresh path (the
  // proactive timer below, the ApiClient 401 retry, and the WS reconnect
  // all converge on refreshSession → performRefresh). Login/MFA-verify mint
  // a session through a different endpoint that never calls this, so those
  // screens sync explicitly themselves right after — see LoginScreen and
  // MfaChallengeScreen.
  persistToken: () => {
    void syncRefreshTokenFromJar();
  },
};

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider config={config}>
          <SessionBootstrap>
            <CallLayer>{children}</CallLayer>
          </SessionBootstrap>
        </RuntimeProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Mirrors packages/app/src/App.tsx's own SessionBootstrap: try to restore a
 * session via the refresh token before rendering anything that reads auth
 * status. Simpler than the web version — mobile has no sibling-window peer
 * session to wait for first (bootstrapFromPeerSession is Electron-only, for
 * its separate meeting window).
 */
function SessionBootstrap({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const [ready, setReady] = useState(false);
  const colors = useThemeColors();

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    let refreshing = false;
    let unresolved = true;
    const restore = async () => {
      if (!alive || refreshing) return;
      refreshing = true;
      try {
        const session = await refreshSession(config.authBase, config.persistToken, config.getRefreshToken);
        if (!alive) return;
        setReady(true);
        if (!shouldRetrySessionBootstrap(session, isSessionDead())) {
          unresolved = false;
          return;
        }

        retryAttempt += 1;
        retryTimer = setTimeout(() => void restore(), sessionBootstrapRetryDelay(retryAttempt));
      } finally {
        refreshing = false;
      }
    };
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || !alive || !unresolved) return;
      if (retryTimer) clearTimeout(retryTimer);
      void restore();
    });
    void restore();
    return () => {
      alive = false;
      appStateSub.remove();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  if (!ready || status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  return <>{children}</>;
}

/**
 * The in-app calling STATE, mounted above the whole app (and its glass popup
 * layers) so anything rendered inside a popup can still reach `useCalls()`.
 * Inert until signed in: no signalling listener, no notification prompt.
 * The call UI itself (`CallOverlay`) is mounted in App.tsx INSIDE GlassProvider,
 * because a real Android background blur needs the app it blurs to be a sibling.
 */
function CallLayer({ children }: { children: ReactNode }) {
  const authed = useSession((s) => s.status === 'authed');
  usePushRegistration();
  return (
    <CallProvider enabled={authed}>
      <View style={{ flex: 1 }}>{children}</View>
    </CallProvider>
  );
}
