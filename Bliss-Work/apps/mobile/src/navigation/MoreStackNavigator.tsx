import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MoreMenuScreen } from '../screens/more/MoreMenuScreen';
import { AccountScreen } from '../screens/more/AccountScreen';
import { ProfileScreen } from '../screens/more/ProfileScreen';
import { SettingsScreen } from '../screens/more/SettingsScreen';
import { MfaSettingsScreen } from '../screens/more/MfaSettingsScreen';
import { ActiveSessionsScreen } from '../screens/more/ActiveSessionsScreen';
import { MyActivityScreen } from '../screens/more/MyActivityScreen';
import { AboutScreen } from '../screens/more/AboutScreen';
import { MembersScreen } from '../screens/more/MembersScreen';
import { MemberDetailScreen } from '../screens/more/MemberDetailScreen';
import { OrgScreen } from '../screens/more/OrgScreen';
import { MailListScreen } from '../screens/more/MailListScreen';
import { MailDetailScreen } from '../screens/mail/MailDetailScreen';
import { MailComposeScreen } from '../screens/mail/MailComposeScreen';
import { ChannelsListScreen } from '../screens/more/ChannelsListScreen';
import { CreateChannelScreen } from '../screens/more/CreateChannelScreen';
import { ChannelDetailScreen } from '../screens/more/ChannelDetailScreen';
import { ChannelConversationScreen } from '../screens/more/ChannelConversationScreen';
import { ChannelMembersScreen } from '../screens/more/ChannelMembersScreen';
import { ChannelFilesScreen } from '../screens/more/ChannelFilesScreen';
import { ChannelSettingsScreen } from '../screens/more/ChannelSettingsScreen';
import type { MoreStackParamList } from './types';

const Stack = createNativeStackNavigator<MoreStackParamList>();

export function MoreStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="MoreMenu" component={MoreMenuScreen} />
      <Stack.Screen name="Account" component={AccountScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="MfaSettings" component={MfaSettingsScreen} />
      <Stack.Screen name="ActiveSessions" component={ActiveSessionsScreen} />
      <Stack.Screen name="MyActivity" component={MyActivityScreen} />
      <Stack.Screen name="About" component={AboutScreen} />
      <Stack.Screen name="Members" component={MembersScreen} />
      <Stack.Screen name="MemberDetail" component={MemberDetailScreen} />
      <Stack.Screen name="Org" component={OrgScreen} />
      <Stack.Screen name="Mail" component={MailListScreen} />
      <Stack.Screen name="MailDetail" component={MailDetailScreen} />
      <Stack.Screen name="MailCompose" component={MailComposeScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="Channels" component={ChannelsListScreen} />
      <Stack.Screen name="CreateChannel" component={CreateChannelScreen} />
      <Stack.Screen name="ChannelDetail" component={ChannelDetailScreen} />
      <Stack.Screen name="ChannelConversation" component={ChannelConversationScreen} />
      <Stack.Screen name="ChannelMembers" component={ChannelMembersScreen} />
      <Stack.Screen name="ChannelFiles" component={ChannelFilesScreen} />
      <Stack.Screen name="ChannelSettings" component={ChannelSettingsScreen} />
    </Stack.Navigator>
  );
}
