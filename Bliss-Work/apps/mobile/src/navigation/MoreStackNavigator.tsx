import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MoreMenuScreen } from '../screens/more/MoreMenuScreen';
import { ProfileScreen } from '../screens/more/ProfileScreen';
import { SettingsScreen } from '../screens/more/SettingsScreen';
import { MfaSettingsScreen } from '../screens/more/MfaSettingsScreen';
import { ActiveSessionsScreen } from '../screens/more/ActiveSessionsScreen';
import { MyActivityScreen } from '../screens/more/MyActivityScreen';
import { WorkspaceScreen } from '../screens/more/WorkspaceScreen';
import { MembersScreen } from '../screens/more/MembersScreen';
import { OrgScreen } from '../screens/more/OrgScreen';
import { MailListScreen } from '../screens/more/MailListScreen';
import { MailDetailScreen } from '../screens/more/MailDetailScreen';
import { ChannelsListScreen } from '../screens/more/ChannelsListScreen';
import { ChannelConversationScreen } from '../screens/more/ChannelConversationScreen';
import type { MoreStackParamList } from './types';

const Stack = createNativeStackNavigator<MoreStackParamList>();

export function MoreStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreMenu" component={MoreMenuScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="MfaSettings" component={MfaSettingsScreen} />
      <Stack.Screen name="ActiveSessions" component={ActiveSessionsScreen} />
      <Stack.Screen name="MyActivity" component={MyActivityScreen} />
      <Stack.Screen name="Workspace" component={WorkspaceScreen} />
      <Stack.Screen name="Members" component={MembersScreen} />
      <Stack.Screen name="Org" component={OrgScreen} />
      <Stack.Screen name="Mail" component={MailListScreen} />
      <Stack.Screen name="MailDetail" component={MailDetailScreen} />
      <Stack.Screen name="Channels" component={ChannelsListScreen} />
      <Stack.Screen name="ChannelConversation" component={ChannelConversationScreen} />
    </Stack.Navigator>
  );
}
