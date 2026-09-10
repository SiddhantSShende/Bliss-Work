import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MeetingsListScreen } from '../screens/meetings/MeetingsListScreen';
import { ScheduleMeetingScreen } from '../screens/meetings/ScheduleMeetingScreen';
import type { MeetingsStackParamList } from './types';

const Stack = createNativeStackNavigator<MeetingsStackParamList>();

export function MeetingsStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MeetingsList" component={MeetingsListScreen} />
      <Stack.Screen name="ScheduleMeeting" component={ScheduleMeetingScreen} />
    </Stack.Navigator>
  );
}
