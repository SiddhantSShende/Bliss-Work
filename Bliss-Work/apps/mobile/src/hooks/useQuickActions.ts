import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as QuickActions from 'expo-quick-actions';
import { navigateToQuickAction, type QuickActionTarget } from '../navigation/navigationRef';

/**
 * Wires up the 💬 Chats / ✅ Tasks / ➕ Assign Task / 📝 New Chat app-icon
 * long-press shortcuts (mounted once for the whole authed session — see
 * AppTabs.tsx, same spot useWsBridge/useConnectEventBridge live).
 *
 * iOS shortcuts are declared statically in Info.plist
 * (UIApplicationShortcutItems) — they need no JS call and are visible even
 * before the JS bundle loads. Android has no supported static-shortcut path
 * (expo-quick-actions' own README: "Static Android actions are not
 * currently supported because they don't support complex intent"), so
 * Android's shortcuts are registered here as dynamic ShortcutManager
 * entries instead; visually indistinguishable from static ones on the
 * long-press menu.
 */
const ANDROID_ACTIONS: { id: QuickActionTarget; title: string }[] = [
  { id: 'chats', title: 'Chats' },
  { id: 'tasks', title: 'Tasks' },
  { id: 'assign-task', title: 'Assign Task' },
  { id: 'new-chat', title: 'New Chat' },
];

export function useQuickActions() {
  const consumedInitial = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'android') {
      void QuickActions.setItems(ANDROID_ACTIONS.map((a) => ({ ...a, icon: 'ic_launcher_foreground' })));
    }

    // Cold start: the tap that launched the app, consumed once.
    if (!consumedInitial.current && QuickActions.initial) {
      consumedInitial.current = true;
      navigateToQuickAction(QuickActions.initial.id as QuickActionTarget);
    }

    // Warm start: app already running (foreground or backgrounded).
    const sub = QuickActions.addListener((action) => {
      navigateToQuickAction(action.id as QuickActionTarget);
    });
    return () => sub.remove();
  }, []);
}
