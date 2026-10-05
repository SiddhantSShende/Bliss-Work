import { isNewResponse } from './responseDedupe';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/**
 * "New Task Assigned" — local, scheduled the instant the event arrives over
 * the already-open WebSocket (TaskAssigned, see useWsBridge.ts). Same
 * "alive but not foreground" reach as the message notifications, and the
 * identical closed-app limit — see messageNotifications.ts's own doc for
 * why (no push-registration endpoint on the backend, see CALLING.md).
 */

const TASK_CHANNEL = 'tasks';
const TASK_CATEGORY = 'task_assigned';

let initPromise: Promise<void> | null = null;

function initTaskNotifications(): Promise<void> {
  if (!initPromise) {
    initPromise = setup().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function setup(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(TASK_CHANNEL, {
      name: 'Tasks',
      description: 'Tasks assigned to you in BlissWork',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }
  await Notifications.setNotificationCategoryAsync(TASK_CATEGORY, []);
}

export interface AssignedTask {
  taskId: string;
  title: string;
  /** Real display name, resolved by the caller from the directory cache —
   *  falls back to the WS event's own senderUsername, never hardcoded. */
  senderName: string;
}

/** Skipped while BlissWork is in the foreground — same "the app itself is
 *  already showing this" reasoning showMissedCallNotification uses; the
 *  assigned-tasks list refreshes live from the same WS event regardless. */
export async function showTaskAssignedNotification(t: AssignedTask): Promise<void> {
  if (AppState.currentState === 'active') return;
  await initTaskNotifications();
  await Notifications.scheduleNotificationAsync({
    // A real task can only ever be assigned once per id at a given moment —
    // reusing the id as the notification's own identifier means a duplicate
    // TaskAssigned frame (a WS redelivery) replaces rather than doubles it.
    identifier: `task-assigned-${t.taskId}`,
    content: {
      title: 'BlissWork',
      subtitle: 'New Task Assigned',
      body: `${t.title}\nAssigned by: ${t.senderName}`,
      categoryIdentifier: TASK_CATEGORY,
      data: { type: 'task', taskId: t.taskId },
      sound: 'default',
    },
    trigger: Platform.OS === 'android' ? { channelId: TASK_CHANNEL } : null,
  });
}

/** Taps on a task notification, including one that launched the app from a
 *  killed state. */
export function onTaskNotificationResponse(cb: (taskId: string) => void): () => void {
  const parse = (r: Notifications.NotificationResponse | null | undefined) => {
    const data = r?.notification.request.content.data as { type?: string; taskId?: string } | undefined;
    return r && data?.type === 'task' && data.taskId && isNewResponse(r) ? data.taskId : null;
  };
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const taskId = parse(resp);
    if (taskId) cb(taskId);
  });
  void Notifications.getLastNotificationResponseAsync().then((resp) => {
    const taskId = parse(resp);
    if (taskId) cb(taskId);
  });
  return () => sub.remove();
}
