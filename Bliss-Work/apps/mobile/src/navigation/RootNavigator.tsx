import { ActivityIndicator, View } from 'react-native';
import { DefaultTheme, DarkTheme, NavigationContainer, type LinkingOptions, type Theme as NavTheme } from '@react-navigation/native';
import { useSession } from '@taskboard/app/store/session';
import { AuthNavigator } from './AuthNavigator';
import { AppTabs } from './AppTabs';
import { navigationRef } from './navigationRef';
import { useAppTheme } from '../theme/ThemeProvider';
import type { AppTabParamList } from './types';

/**
 * `blisswork://tasks`, `blisswork://chats`, `blisswork://assign-task`,
 * `blisswork://new-chat` — React Navigation resolves these against whichever
 * navigator is currently mounted below, cold/warm/foreground alike, so a
 * link opened while signed out (AuthNavigator has none of these routes)
 * gracefully no-ops instead of crashing, same as an unauthenticated app-icon
 * Quick Action tap (see navigationRef.ts).
 */
const linking: LinkingOptions<AppTabParamList> = {
  prefixes: ['blisswork://'],
  config: {
    screens: {
      Tasks: { screens: { TasksList: 'tasks', AssignTask: 'assign-task' } },
      Chats: { screens: { ChatsList: 'chats', NewChat: 'new-chat' } },
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
export function RootNavigator() {
  const status = useSession((s) => s.status);
  const { colors, isDark } = useAppTheme();

  // Fills the letterbox React Navigation itself paints during screen
  // transitions (every screen here uses headerShown: false, so nothing else
  // sets this) — without it, toggling dark mode leaves a white flash behind
  // every navigation animation.
  const navTheme: NavTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: { ...(isDark ? DarkTheme : DefaultTheme).colors, background: colors.bg, card: colors.surface, border: colors.border, text: colors.fg, primary: colors.accent },
  };

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} linking={linking} theme={navTheme}>
      {status === 'authed' ? <AppTabs /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
