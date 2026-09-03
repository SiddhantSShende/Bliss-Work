import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { useSession } from '@taskboard/app/store/session';
import { AuthNavigator } from './AuthNavigator';
import { AppTabs } from './AppTabs';
import { colors } from '../constants/theme';

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

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return <NavigationContainer>{status === 'authed' ? <AppTabs /> : <AuthNavigator />}</NavigationContainer>;
}
