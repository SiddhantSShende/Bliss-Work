import { useCallback, useEffect } from 'react';
import { BackHandler } from 'react-native';
import { quickActions, useQuickState } from './quickActionStore';
import { finishAndRemoveQuickActionTask } from './quickActionTask';
import { QuickChannelScreen } from './QuickChannelScreen';
import { QuickChatScreen } from './QuickChatScreen';
import { QuickTaskScreen } from './QuickTaskScreen';

/**
 * Renders the launcher-shortcut flow full screen, in place of the tab bar.
 *
 * Leaving it (back arrow, hardware Back, "Done"): if the shortcut cold-started
 * the app, the activity is finished so the user lands back on the launcher; if
 * BlissWork was already open, we just return to where they were. The store is
 * cleared FIRST — a finished activity can leave the JS runtime alive, and a
 * stale mode would show the quick flow again on the next normal launch.
 */
export function QuickActionHost() {
  const { mode } = useQuickState();

  const finish = useCallback(() => {
    const wasCold = quickActions.get().cold;
    const bareTask = wasCold && !quickActions.hasShownNormalApp();
    quickActions.close();
    if (!wasCold) return;
    // The same exit BlissWork always did on a cold quick-action launch —
    // unconditional, so this can never regress. finishAndRemoveTask() below
    // is a purely ADDITIVE best-effort cleanup, not a replacement for it: on
    // a real device `activity.finishAndRemoveTask()` returning true does not
    // guarantee Android's WindowOrganizer actually completed the removal (an
    // emulator run of this exact code logged the task surviving anyway, with
    // the system server printing "WindowOrganizerController: Attempting to
    // externally change a non-organized container" — a failure this process
    // has no way to detect or catch), so nothing here may skip the line below.
    if (bareTask) finishAndRemoveQuickActionTask();
    BackHandler.exitApp();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      finish();
      return true;
    });
    return () => sub.remove();
  }, [finish]);

  if (mode === 'chat') return <QuickChatScreen onDone={finish} />;
  if (mode === 'channel') return <QuickChannelScreen onDone={finish} />;
  if (mode === 'task') return <QuickTaskScreen onDone={finish} />;
  return null;
}
