import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ChatsListScreen } from '../screens/chats/ChatsListScreen';
import { ChatConversationScreen } from '../screens/chats/ChatConversationScreen';
import { NewChatScreen } from '../screens/chats/NewChatScreen';

import { MailDetailScreen } from '../screens/mail/MailDetailScreen';
import { MailComposeScreen } from '../screens/mail/MailComposeScreen';
import { CreateChannelScreen } from '../screens/more/CreateChannelScreen';
import { ChannelDetailScreen } from '../screens/more/ChannelDetailScreen';
import { ChannelConversationScreen } from '../screens/more/ChannelConversationScreen';
import { ChannelMembersScreen } from '../screens/more/ChannelMembersScreen';
import { ChannelFilesScreen } from '../screens/more/ChannelFilesScreen';
import { ChannelSettingsScreen } from '../screens/more/ChannelSettingsScreen';

import type { ChatsStackParamList } from './types';

const Stack = createNativeStackNavigator<ChatsStackParamList>();

export function ChatsStackNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}>
      <Stack.Screen name="ChatsList" component={ChatsListScreen} />
      <Stack.Screen name="ChatConversation" component={ChatConversationScreen} />
      <Stack.Screen name="NewChat" component={NewChatScreen} />
      <Stack.Screen name="MailDetail" component={MailDetailScreen} />
      <Stack.Screen name="MailCompose" component={MailComposeScreen} options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="CreateChannel" component={CreateChannelScreen} />
      <Stack.Screen name="ChannelDetail" component={ChannelDetailScreen} />
      <Stack.Screen name="ChannelConversation" component={ChannelConversationScreen} />
      <Stack.Screen name="ChannelMembers" component={ChannelMembersScreen} />
      <Stack.Screen name="ChannelFiles" component={ChannelFilesScreen} />
      <Stack.Screen name="ChannelSettings" component={ChannelSettingsScreen} />
    </Stack.Navigator>
  );
}
