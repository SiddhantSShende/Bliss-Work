import { Home } from 'lucide-react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { HomeScreen } from '../screens/home/HomeScreen';
import { colors } from '../constants/theme';

const Tab = createBottomTabNavigator();

/**
 * Signed-in surface. Just Home for Phase A — proves the tab shell and auth
 * gating work end to end. Mail, Meetings, Chats, Tasks and Channels are
 * added as their own tabs in Phases B–D, with Members/Org/Settings under a
 * "More" tab, mirroring the priority order this session's own web-responsive
 * work already settled on for a narrow viewport (packages/app/src/routes/
 * Rail.tsx) rather than re-deriving it.
 */
export function AppTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ color, size }) => <Home color={color} size={size} /> }}
      />
    </Tab.Navigator>
  );
}
