/**
 * Mobile-owned React Query key registry. Deliberately NOT the shared `qk`
 * from packages/app/src/lib/queryBridge.tsx — that module imports
 * `react-router-dom` at the top level (for `WsEventBridge`'s `useNavigate`),
 * which cannot be required in a React Native bundle. Mobile's screens are
 * also a smaller, DM/channel-focused surface than web's unified inbox, so a
 * separate, purpose-built set of keys is the honest shape here rather than
 * forcing web's broader model onto a surface that doesn't have it.
 */
export const qk = {
  me: ['me'] as const,
  conversations: ['conversations'] as const,
  messages: (conversationId: string) => ['messages', conversationId] as const,
  directory: ['directory'] as const,
  myOrgs: ['myOrgs'] as const,
  notifications: ['notifications'] as const,
  tasksAssigned: ['tasksAssigned'] as const,
  tasksSent: ['tasksSent'] as const,
  taskDetail: (taskId: string) => ['taskDetail', taskId] as const,
  myCalls: ['myCalls'] as const,
  callHistory: ['callHistory'] as const,
  channels: ['channels'] as const,
  channelMessages: (channelId: string) => ['channelMessages', channelId] as const,
  mailInbox: ['mailInbox'] as const,
  mailDetail: (mailId: string) => ['mailDetail', mailId] as const,
  presence: ['presence'] as const,
  activeSessions: ['activeSessions'] as const,
  mfaMethods: ['mfaMethods'] as const,
  activityTimeline: (userId: string, category: string) => ['activityTimeline', userId, category] as const,
};
