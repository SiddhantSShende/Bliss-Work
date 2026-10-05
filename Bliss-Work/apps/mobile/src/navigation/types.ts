import type { NavigatorScreenParams } from '@react-navigation/native';
import type { MailPrefill } from '@taskboard/app/lib/mailActions';

/** Carries exactly what MfaChallenge.tsx (web) puts in router state — see
 *  Login.tsx's nav("/mfa-challenge", { state }) — as navigation params
 *  instead, since React Navigation has no in-memory-only equivalent of
 *  react-router's location.state that survives a screen transition. */
export type AuthStackParamList = {
  Login: undefined;
  MfaChallenge: {
    pendingToken: string;
    methods: 'totp'[];
    enrollmentRequired: boolean;
  };
};

export type ChatsStackParamList = {
  /** `tab` preselects the Chats / Channels / Mail segment (e.g. Home's Unread Mails tile). */
  ChatsList: { tab?: 'chats' | 'channels' | 'mail' } | undefined;
  ChatConversation: { conversationId: string; peerId: string; peerName: string };
  NewChat: undefined;
  MailDetail: { mailId: string };
  /** New mail / reply / forward, or (with `draftId`) resuming a draft. */
  MailCompose: { draftId?: string; prefill?: MailPrefill } | undefined;
  /** Creates a new channel, unless `addToChannelId` is set — then it's the
   *  same member-search picker in "Add Members to an existing channel" mode
   *  (ChannelMembersScreen's "Add Members" button), reusing one screen
   *  instead of building a second near-identical picker. */
  CreateChannel: { addToChannelId?: string; addToChannelName?: string } | undefined;
  ChannelDetail: { channelId: string; channelName: string };
  ChannelConversation: { channelId: string; channelName: string };
  ChannelMembers: { channelId: string; channelName: string };
  ChannelFiles: { channelId: string; channelName: string };
  ChannelSettings: { channelId: string; channelName: string };
};

export type TasksStackParamList = {
  TasksList: undefined;
  TaskDetail: { taskId: string };
  AssignTask: undefined;
};

export type MeetingsStackParamList = {
  MeetingsList: undefined;
  /** `inviteeId`/`inviteeName` are set when reached from a chat header's
   *  "Schedule Call" (see ChatConversationScreen's CallOptionsMenu) to
   *  preset the peer as an invitee; absent when reached from the Meetings
   *  tab's own "+" button. */
  ScheduleMeeting: { inviteeId?: string; inviteeName?: string } | undefined;
  /** "View all" from the Meetings screen: every upcoming or every past meeting. */
  MeetingsAll: { kind: 'upcoming' | 'past' };
  MeetingDetail: { callId: string };
};

export type MoreStackParamList = {
  /** The More tab's own landing screen: workspace switcher card + Mail/
   *  Channels/Members/Org + Settings — mirrors the reference "More" screen. */
  MoreMenu: undefined;
  /** The account hub (reference's "Profile" screen) — My Profile/
   *  Notifications/Theme/Privacy & Security/Help & Support/About/Sign out.
   *  Reached from MoreMenu's header avatar/gear, not the tab bar itself. */
  Account: undefined;
  /** "My Profile": the actual edit form (name, photo). */
  Profile: undefined;
  /** "Privacy & Security": 2FA, active sessions, activity log. */
  Settings: undefined;
  MfaSettings: undefined;
  ActiveSessions: undefined;
  MyActivity: undefined;
  About: undefined;
  Members: undefined;
  /** Admin-only (org_admin) — the screen re-checks the role and every query
   *  behind it is enforced server-side; see MemberDetailScreen. */
  MemberDetail: { userId: string };
  Org: undefined;
  Mail: undefined;
  MailDetail: { mailId: string };
  MailCompose: { draftId?: string; prefill?: MailPrefill } | undefined;
  Channels: undefined;
  CreateChannel: { addToChannelId?: string; addToChannelName?: string } | undefined;
  ChannelDetail: { channelId: string; channelName: string };
  ChannelConversation: { channelId: string; channelName: string };
  ChannelMembers: { channelId: string; channelName: string };
  ChannelFiles: { channelId: string; channelName: string };
  ChannelSettings: { channelId: string; channelName: string };
};

export type HomeStackParamList = {
  HomeDashboard: undefined;
};

/** The signed-in bottom-tab shell: Home, Chats, Tasks, Meetings, More. Each is a
 *  nested stack (see the *StackParamLists above) — react-navigation types a
 *  nested navigator's tab as `NavigatorScreenParams<...>`, so a cross-tab
 *  jump (e.g. Chats → More → Workspace) stays type-checked too. */
export type AppTabParamList = {
  Home: NavigatorScreenParams<HomeStackParamList> | undefined;
  Chats: NavigatorScreenParams<ChatsStackParamList> | undefined;
  Tasks: NavigatorScreenParams<TasksStackParamList> | undefined;
  Meetings: NavigatorScreenParams<MeetingsStackParamList> | undefined;
  More: NavigatorScreenParams<MoreStackParamList> | undefined;
};
