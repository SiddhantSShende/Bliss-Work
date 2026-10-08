export type QuickMode = 'chat' | 'channel' | 'task';

/**
 * The launcher shortcuts (android/app/src/main/res/xml/shortcuts.xml, iOS
 * Info.plist) open `blisswork://quick/<chat|channel|task>` — a dedicated entry
 * point, distinct from the normal deep links (`blisswork://chats` etc.) that
 * navigate inside the regular tabs.
 */
export function quickModeFromUrl(url: string | null | undefined): QuickMode | null {
  if (!url) return null;
  const m = /^blisswork:\/\/quick\/(chat|channel|task)\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? (m[1]!.toLowerCase() as QuickMode) : null;
}

/** Ignore React Native's cached launch URL when the app merely resumes. */
export function shouldProcessForegroundLaunchUrl(
  url: string | null | undefined,
  lastLaunchUrl: string | null,
): url is string {
  return !!url && url !== lastLaunchUrl;
}

/** iOS home-screen quick-action ids (Info.plist UIApplicationShortcutItemType) -> quick flow. */
export function quickModeFromActionId(id: string): QuickMode | null {
  switch (id) {
    case 'chats':
    case 'blisswork_chats':
      return 'chat';
    case 'channels':
    case 'blisswork_channels':
      return 'channel';
    case 'assign-task':
    case 'tasks':
    case 'blisswork_tasks':
      return 'task';
    default:
      return null;
  }
}
