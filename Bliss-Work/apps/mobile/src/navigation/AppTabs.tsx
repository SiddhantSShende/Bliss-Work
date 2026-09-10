import { MessageCircle, CheckSquare, Video, MoreHorizontal } from 'lucide-react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useConnectEventBridge } from '@taskboard/app/lib/runtime';
import { ChatsStackNavigator } from './ChatsStackNavigator';
import { TasksStackNavigator } from './TasksStackNavigator';
import { MeetingsStackNavigator } from './MeetingsStackNavigator';
import { MoreStackNavigator } from './MoreStackNavigator';
import { useConversations } from '../hooks/useConversations';
import { useNotifications } from '../hooks/useNotifications';
import { useMailInbox } from '../hooks/useMailInbox';
import { useChannels } from '../hooks/useChannels';
import { useWsBridge } from '../hooks/useWsBridge';
import { useQuickActions } from '../hooks/useQuickActions';
import { useThemeColors } from '../theme/ThemeProvider';
import type { AppTabParamList } from './types';

const Tab = createBottomTabNavigator<AppTabParamList>();

/**
 * Signed-in surface: Chats, Tasks, Meetings, More — no Home tab. Chats is the
 * `initialRouteName` (also simply first in registration order below) so it's
 * the screen every authed user lands on, whether that's a fresh login, a
 * cold relaunch, or a resume from background — there is no "last visited
 * tab" persistence anywhere in this app (React Navigation just keeps
 * whichever screen was already mounted showing across an ordinary
 * background/foreground cycle, same as any other RN app), so the only way
 * a DIFFERENT tab could ever be the first thing shown is a fresh mount of
 * this navigator, which always starts here.
 *
 * Mail/Channels/Members/Org — folded under Home's old grid — now live behind
 * a header icon on the Chats screen (see ChatsListScreen's "Workspace"
 * button) instead of a tab of their own, since More is now the account menu
 * (Profile/Settings/Dark Theme/Sign out), not a feature grid.
 *
 * Connects the realtime socket + this app's WS→cache bridge exactly once for
 * the whole authed session, the same way AppShell.tsx mounts WsEventBridge
 * once for all of /app on web — every screen underneath gets live updates
 * for free instead of each one wiring its own subscription.
 */
export function AppTabs() {
  useConnectEventBridge();
  useWsBridge();
  useQuickActions();
  const colors = useThemeColors();

  const { data: conversations } = useConversations();
  const { data: notifications } = useNotifications();
  const { data: mailPage } = useMailInbox();
  const { data: channels } = useChannels();

  const chatsBadge = conversations?.reduce((sum, c) => sum + c.unread, 0) ?? 0;
  const tasksBadge = notifications?.filter((n) => !n.read).length ?? 0;
  const mailUnread = mailPage?.items.reduce((sum, it) => sum + it.unreadCount, 0) ?? 0;
  const channelsUnread = channels?.reduce((sum, c) => sum + c.unread, 0) ?? 0;
  const moreBadge = mailUnread + channelsUnread;
  // Same "99+" cap Rail.tsx (web) already uses — tabBarBadge takes a string
  // or number verbatim with no cap of its own.
  const capped = (n: number) => (n > 99 ? '99+' : n);

  return (
    <Tab.Navigator
      initialRouteName="Chats"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { borderTopColor: colors.border, backgroundColor: colors.surface },
      }}
    >
      <Tab.Screen
        name="Chats"
        component={ChatsStackNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
          tabBarBadge: chatsBadge > 0 ? capped(chatsBadge) : undefined,
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksStackNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <CheckSquare color={color} size={size} />,
          tabBarBadge: tasksBadge > 0 ? capped(tasksBadge) : undefined,
        }}
      />
      <Tab.Screen
        name="Meetings"
        component={MeetingsStackNavigator}
        options={{ tabBarIcon: ({ color, size }) => <Video color={color} size={size} /> }}
      />
      <Tab.Screen
        name="More"
        component={MoreStackNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <MoreHorizontal color={color} size={size} />,
          tabBarBadge: moreBadge > 0 ? capped(moreBadge) : undefined,
        }}
      />
    </Tab.Navigator>
  );
}
