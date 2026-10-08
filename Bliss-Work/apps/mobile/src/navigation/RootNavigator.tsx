import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, View } from 'react-native';
import { DefaultTheme, DarkTheme, NavigationContainer, type LinkingOptions, type Theme as NavTheme } from '@react-navigation/native';
import { useSession } from '@taskboard/app/store/session';
import { AuthNavigator } from './AuthNavigator';
import { AppTabs } from './AppTabs';
import { navigateToUrl, navigationRef } from './navigationRef';
import { useAppTheme } from '../theme/ThemeProvider';
import { useQuickActions } from '../hooks/useQuickActions';
import { QuickActionHost } from '../quick/QuickActionHost';
import { quickActions, useQuickState } from '../quick/quickActionStore';
import { quickModeFromUrl, shouldProcessForegroundLaunchUrl } from '../quick/quickLinks';
import type { AppTabParamList } from './types';

/**
 * `blisswork://tasks`, `blisswork://chats`, `blisswork://assign-task`,
 * `blisswork://new-chat`, `blisswork://channels` — React Navigation resolves
 * these against whichever navigator is currently mounted below, cold/warm/
 * foreground alike, so a link opened while signed out (AuthNavigator has
 * none of these routes) gracefully no-ops instead of crashing, same as an
 * unauthenticated app-icon Quick Action tap (see navigationRef.ts).
 */
const linking: LinkingOptions<AppTabParamList> = {
  prefixes: ['blisswork://'],
  config: {
    screens: {
      Tasks: { screens: { TasksList: 'tasks', AssignTask: 'assign-task' } },
      // `blisswork://chats/channels` (the Channels launcher shortcut) opens Chats with the
      // Channels segment selected; `blisswork://chats` and `.../mail` work the same way.
      Chats: { screens: { ChatsList: 'chats/:tab?', NewChat: 'new-chat' } },
      More: { screens: { Channels: 'channels' } },
    },
  },
};

/**
 * Switches between the signed-out and signed-in navigators on session
 * status — the same reactive pattern packages/app/src/lib/RequireAuth.tsx
 * uses on web, just applied at the navigator root instead of a route guard
 * (React Navigation has no client-side router to guard a path in).
 *
 * By the time this renders, AppProviders' own SessionBootstrap has already
 * resolved "loading" one way or the other, so the only remaining loading
 * state here is impossible in practice — kept as a defensive fallback
 * rather than assuming that invariant always holds.
 */
/**
 * A launcher shortcut / deep link that opened the app while nobody was signed in.
 * React Navigation drops a URL that matches no screen of the mounted (signed-out)
 * navigator, so remember it and replay it once the session is authenticated.
 */
let pendingUrl: string | null = null;

export function RootNavigator() {
  const status = useSession((s) => s.status);
  const quick = useQuickState();
  const lastLaunchUrl = useRef<string | null>(null);
  // Until the launching URL has been read we don't know whether to draw the tabs or a quick flow,
  // so hold a spinner for that one async read instead of flashing the tabs first.
  const [launchChecked, setLaunchChecked] = useState(false);
  useQuickActions();

  // Launcher shortcuts arrive as `blisswork://quick/<chat|channel|task>`:
  //  - cold start: the URL is the activity's launch intent (getInitialURL);
  //  - app already running: Android delivers a new intent -> the 'url' event;
  //  - process alive but the activity was finished and re-created by the shortcut: re-read the
  //    launch intent on foreground, but ignore React Native's cached cold-start URL.
  // The mode is kept in a store (not tied to the session), so an expired session shows login and the
  // same quick flow resumes after signing in again.
  useEffect(() => {
    let alive = true;
    let initialUrlRead = false;
    const open = (url: string | null, cold: boolean) => {
      const mode = quickModeFromUrl(url);
      if (!mode) return;
      const cur = quickActions.get();
      quickActions.open(mode, cur.mode ? cur.cold : cold);
    };
    Linking.getInitialURL()
      .then((url) => {
        if (!alive) return;
        lastLaunchUrl.current = url;
        open(url, true);
      })
      .catch(() => undefined)
      .finally(() => {
        initialUrlRead = true;
        if (alive) setLaunchChecked(true);
      });
    const urlSub = Linking.addEventListener('url', ({ url }) => {
      if (quickModeFromUrl(url)) lastLaunchUrl.current = url;
      open(url, false);
    });
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && initialUrlRead && !quickActions.get().mode) {
        void Linking.getInitialURL()
          .then((url) => {
            if (!shouldProcessForegroundLaunchUrl(url, lastLaunchUrl.current)) return;
            lastLaunchUrl.current = url;
            open(url, true);
          })
          .catch(() => undefined);
      }
    });
    return () => {
      alive = false;
      urlSub.remove();
      appSub.remove();
    };
  }, []);

  useEffect(() => {
    if (status !== 'authed') {
      void Linking.getInitialURL().then((url) => {
        if (url && useSession.getState().status !== 'authed') pendingUrl = url;
      });
      const sub = Linking.addEventListener('url', ({ url }) => {
        if (useSession.getState().status !== 'authed') pendingUrl = url;
      });
      return () => sub.remove();
    }
    if (pendingUrl) {
      const url = pendingUrl;
      pendingUrl = null;
      // Wait a tick so AppTabs (and its navigators) are mounted.
      const t = setTimeout(() => navigateToUrl(url), 300);
      return () => clearTimeout(t);
    }
  }, [status]);
  const { colors, isDark } = useAppTheme();

  // React Navigation paints `background` behind every screen and during
  // transitions. Here it is TRANSPARENT: the theme's atmosphere is drawn once,
  // underneath the whole app (GlassProvider), and the glass panels on every
  // screen read it through the screens. An opaque value here would hide it.
  const navTheme: NavTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: { ...(isDark ? DarkTheme : DefaultTheme).colors, background: 'transparent', card: 'transparent', border: colors.border, text: colors.fg, primary: colors.accent },
  };

  // AppTabs is about to render: this task may now hold real navigation state,
  // so a cold quick-action launch's exit path must never tear it down (see
  // quickActionStore.markNormalAppShown / QuickActionHost.finish).
  useEffect(() => {
    if (status === 'authed' && !quick.mode) quickActions.markNormalAppShown();
  }, [status, quick.mode]);

  if (status === 'loading' || !launchChecked) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} linking={linking} theme={navTheme}>
      {status === 'authed' ? quick.mode ? <QuickActionHost /> : <AppTabs /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
