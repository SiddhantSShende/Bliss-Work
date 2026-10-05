import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MeetingsListScreen } from '../screens/meetings/MeetingsListScreen';
import { ScheduleMeetingScreen } from '../screens/meetings/ScheduleMeetingScreen';
import { MeetingsAllScreen } from '../screens/meetings/MeetingsAllScreen';
import { MeetingDetailScreen } from '../screens/meetings/MeetingDetailScreen';
import type { MeetingsStackParamList } from './types';

const Stack = createNativeStackNavigator<MeetingsStackParamList>();

export function MeetingsStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="MeetingsList" component={MeetingsListScreen} />
      <Stack.Screen name="ScheduleMeeting" component={ScheduleMeetingScreen} />
      <Stack.Screen name="MeetingsAll" component={MeetingsAllScreen} />
      <Stack.Screen name="MeetingDetail" component={MeetingDetailScreen} />
    </Stack.Navigator>
  );
}
