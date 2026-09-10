import type { NavigatorScreenParams } from '@react-navigation/native';

/** Carries exactly what MfaChallenge.tsx (web) puts in router state — see
 *  Login.tsx's nav("/mfa-challenge", { state }) — as navigation params
 *  instead, since React Navigation has no in-memory-only equivalent of
 *  react-router's location.state that survives a screen transition. */
export type AuthStackParamList = {
  Login: undefined;
  MfaChallenge: {
    pendingToken: string;
    methods: ('totp' | 'webauthn')[];
    enrollmentRequired: boolean;
  };
};

export type ChatsStackParamList = {
  ChatsList: undefined;
  ChatConversation: { conversationId: string; peerId: string; peerName: string };
  NewChat: undefined;
};

export type TasksStackParamList = {
  TasksList: undefined;
  TaskDetail: { taskId: string };
  AssignTask: undefined;
};

export type MeetingsStackParamList = {
  MeetingsList: undefined;
  ScheduleMeeting: undefined;
};

export type MoreStackParamList = {
  /** The More tab's own landing screen: Profile / Settings / Dark Theme /
   *  Sign out — the account menu, not a feature grid (see Workspace below
   *  for where Mail/Channels/Members/Org moved). */
  MoreMenu: undefined;
  Profile: undefined;
  Settings: undefined;
  MfaSettings: undefined;
  ActiveSessions: undefined;
  MyActivity: undefined;
  /** Mail/Channels/Members/Org's entry point, now that Home (which used to
   *  grid all of these) is gone — reached from Chats' header icon via a
   *  cross-tab jump into this stack, not from the More tab itself. */
  Workspace: undefined;
  Members: undefined;
  Org: undefined;
  Mail: undefined;
  MailDetail: { mailId: string };
  Channels: undefined;
  ChannelConversation: { channelId: string; channelName: string };
};

/** The signed-in bottom-tab shell: Chats, Tasks, Meetings, More — no Home
 *  tab (see AppTabs.tsx for why Chats is the landing tab instead). Each is a
 *  nested stack (see the *StackParamLists above) — react-navigation types a
 *  nested navigator's tab as `NavigatorScreenParams<...>`, so a cross-tab
 *  jump (e.g. Chats → More → Workspace) stays type-checked too. */
export type AppTabParamList = {
  Chats: NavigatorScreenParams<ChatsStackParamList> | undefined;
  Tasks: NavigatorScreenParams<TasksStackParamList> | undefined;
  Meetings: NavigatorScreenParams<MeetingsStackParamList> | undefined;
  More: NavigatorScreenParams<MoreStackParamList> | undefined;
};
