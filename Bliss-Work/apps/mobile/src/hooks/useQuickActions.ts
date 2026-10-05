import { useEffect, useRef } from 'react';
import * as QuickActions from 'expo-quick-actions';
import { quickActions } from '../quick/quickActionStore';
import { quickModeFromActionId } from '../quick/quickLinks';
import { navigateToQuickAction, type QuickActionTarget } from '../navigation/navigationRef';

/**
 * Receives the iOS home-screen quick actions (Info.plist
 * `UIApplicationShortcutItems`) and routes them into the same Quick Chat /
 * Quick Channel / Quick Task flows the Android launcher shortcuts open.
 *
 * Mounted at the app ROOT (RootNavigator), not inside the tabs: on a cold start
 * the tabs are never rendered when a quick flow is showing, so a hook living
 * there would never see the launching action.
 *
 * Android does not use this at all: its shortcuts are static (res/xml/
 * shortcuts.xml) `blisswork://quick/<flow>` VIEW intents, picked up by the
 * Linking listener in RootNavigator. (Registering Android ones dynamically here
 * as well would list every shortcut twice.)
 */
function handle(id: string, cold: boolean) {
  const mode = quickModeFromActionId(id);
  if (mode) {
    const cur = quickActions.get();
    quickActions.open(mode, cur.mode ? cur.cold : cold);
    return;
  }
  navigateToQuickAction(id as QuickActionTarget); // 'tasks' / 'new-chat' style ids keep their tab navigation
}

export function useQuickActions() {
  const consumedInitial = useRef(false);

  useEffect(() => {
    // Cold start: the tap that launched the app, consumed once.
    if (!consumedInitial.current && QuickActions.initial) {
      consumedInitial.current = true;
      handle(QuickActions.initial.id, true);
    }
    // Warm start: app already running (foreground or backgrounded).
    const sub = QuickActions.addListener((action) => handle(action.id, false));
    return () => sub.remove();
  }, []);
}
