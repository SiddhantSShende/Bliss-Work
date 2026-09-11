import { createNavigationContainerRef } from '@react-navigation/native';
import type { AppTabParamList } from './types';

/**
 * Lets code outside the component tree (the Quick Actions listener in
 * useQuickActions.ts) drive navigation the same way a push notification
 * handler would — see RootNavigator.tsx's `<NavigationContainer ref=.../>`.
 * The declarative `linking` config on that same NavigationContainer handles
 * actual `blisswork://` URL opens; this covers native Quick Action taps,
 * which arrive as a bare action id rather than a URL.
 */
export const navigationRef = createNavigationContainerRef<AppTabParamList>();

export type QuickActionTarget = 'tasks' | 'chats' | 'assign-task' | 'new-chat' | 'channels';

/**
 * Routes a Quick Action id to the same screens `blisswork://<id>` resolves
 * to via RootNavigator's `linking` config. `navigate` (not `push`/`reset`)
 * throughout so repeat taps bring the existing screen to front instead of
 * stacking a duplicate — the app's tab/stack state is otherwise untouched,
 * which is what keeps a background/already-open app from growing duplicate
 * navigation stacks.
 *
 * No-ops (with a dev-only warning from React Navigation itself) if the
 * signed-out AuthNavigator is currently mounted instead of AppTabs — these
 * screens only exist once signed in, same as the `linking` config's own
 * behavior for a URL opened while logged out.
 */
export function navigateToQuickAction(target: QuickActionTarget) {
  if (!navigationRef.isReady()) return;

  switch (target) {
    case 'tasks':
      navigationRef.navigate('Tasks', { screen: 'TasksList' });
      return;
    case 'assign-task':
      navigationRef.navigate('Tasks', { screen: 'AssignTask' });
      return;
    case 'chats':
      navigationRef.navigate('Chats', { screen: 'ChatsList' });
      return;
    case 'new-chat':
      navigationRef.navigate('Chats', { screen: 'NewChat' });
      return;
    case 'channels':
      navigationRef.navigate('More', { screen: 'Channels' });
      return;
  }
}
