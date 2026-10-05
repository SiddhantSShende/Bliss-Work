import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeDashboardScreen } from '../screens/home/HomeDashboardScreen';
import type { HomeStackParamList } from './types';
import { useThemeColors } from '../theme/ThemeProvider';

const Stack = createNativeStackNavigator<HomeStackParamList>();

export function HomeStackNavigator() {
  const colors = useThemeColors();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.fg,
        animation: 'fade',
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen
        name="HomeDashboard"
        component={HomeDashboardScreen}
        options={{ headerShown: false }}
      />
    </Stack.Navigator>
  );
}
