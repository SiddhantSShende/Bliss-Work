import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { MessageCircle, CheckSquare, Video, MoreHorizontal, Home } from 'lucide-react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectEventBridge } from '@taskboard/app/lib/runtime';
import { HomeStackNavigator } from './HomeStackNavigator';
import { ChatsStackNavigator } from './ChatsStackNavigator';
import { TasksStackNavigator } from './TasksStackNavigator';
import { MeetingsStackNavigator } from './MeetingsStackNavigator';
import { MoreStackNavigator } from './MoreStackNavigator';
import { useConversations } from '../hooks/useConversations';
import { useNotifications } from '../hooks/useNotifications';
import { useMailInbox } from '../hooks/useMailInbox';
import { useChannels } from '../hooks/useChannels';
import { useWsBridge } from '../hooks/useWsBridge';
import { GlassSurface } from '../components/glass/GlassSurface';
import { useThemeColors } from '../theme/ThemeProvider';
import type { AppTabParamList } from './types';

const Tab = createBottomTabNavigator<AppTabParamList>();

const NAV_HEIGHT = 64;
const NAV_RADIUS = 28;

/** Tab icon; the active tab gets a soft accent glow pill behind it. */
function TabIcon({ focused, children }: { focused: boolean; children: ReactNode }) {
  const colors = useThemeColors();
  return (
    <View style={[tabIconStyles.wrap, focused && { backgroundColor: colors.selected, borderWidth: 1, borderColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.6, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } }]}>{children}</View>
  );
}
const tabIconStyles = StyleSheet.create({
  wrap: { width: 44, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});

export function AppTabs() {
  useConnectEventBridge();
  useWsBridge();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  const { data: conversations } = useConversations();
  const { data: notifications } = useNotifications();
  const { data: mailPage } = useMailInbox();
  const { data: channels } = useChannels();

  const chatsBadge = conversations?.reduce((sum, c) => sum + c.unread, 0) ?? 0;
  const tasksBadge = notifications?.filter((n) => !n.read).length ?? 0;
  const mailUnread = mailPage?.pages.flatMap((p) => p.items).reduce((sum, it) => sum + it.unreadCount, 0) ?? 0;
  const channelsUnread = channels?.reduce((sum, c) => sum + c.unread, 0) ?? 0;
  const moreBadge = mailUnread + channelsUnread;
  const capped = (n: number) => (n > 99 ? '99+' : n);

  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        // Tabs are plain icon + label: no per-tab fill in any state (the active tab is shown by tint only).
        tabBarVariant: 'uikit',
        tabBarActiveBackgroundColor: 'transparent',
        tabBarInactiveBackgroundColor: 'transparent',
        // Screens are transparent over the shared atmosphere.
        sceneStyle: { backgroundColor: 'transparent' },
        // A floating glass panel, not a full-width opaque bar: the bar itself is
        // transparent and `tabBarBackground` draws the glass (blur, reflection, edge).
        // It stays in the layout flow (not absolute) so every screen keeps ending above it.
        tabBarBackground: () => <GlassSurface variant="navigation" borderRadius={NAV_RADIUS} style={StyleSheet.absoluteFill} blur />,
        tabBarStyle: {
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
          height: NAV_HEIGHT,
          marginHorizontal: 14,
          marginBottom: Math.max(insets.bottom, 10),
          paddingTop: 6,
          paddingBottom: 6,
        },
        tabBarItemStyle: { borderRadius: NAV_RADIUS },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeStackNavigator}
        options={{
          tabBarIcon: ({ color, size, focused }) => <TabIcon focused={focused}><Home color={color} size={size} /></TabIcon>,
        }}
      />
      <Tab.Screen
        name="Chats"
        component={ChatsStackNavigator}
        options={{
          tabBarIcon: ({ color, size, focused }) => <TabIcon focused={focused}><MessageCircle color={color} size={size} /></TabIcon>,
          tabBarBadge: chatsBadge > 0 ? capped(chatsBadge) : undefined,
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksStackNavigator}
        options={{
          tabBarIcon: ({ color, size, focused }) => <TabIcon focused={focused}><CheckSquare color={color} size={size} /></TabIcon>,
          tabBarBadge: tasksBadge > 0 ? capped(tasksBadge) : undefined,
        }}
      />
      <Tab.Screen
        name="Meetings"
        component={MeetingsStackNavigator}
        options={{ tabBarIcon: ({ color, size, focused }) => <TabIcon focused={focused}><Video color={color} size={size} /></TabIcon> }}
      />
      <Tab.Screen
        name="More"
        component={MoreStackNavigator}
        options={{
          tabBarIcon: ({ color, size, focused }) => <TabIcon focused={focused}><MoreHorizontal color={color} size={size} /></TabIcon>,
          tabBarBadge: moreBadge > 0 ? capped(moreBadge) : undefined,
        }}
      />
    </Tab.Navigator>
  );
}
