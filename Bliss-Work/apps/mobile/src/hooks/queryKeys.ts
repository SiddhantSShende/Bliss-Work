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
  /** Prefix only — `useReactions` appends its own per-page cursor
   *  (`[...qk.reactions(id), pageParam]`) so one invalidate here (e.g. from a
   *  WS reaction event) clears every loaded page's tally in one call, via
   *  React Query's default prefix matching. Kept off `qk.messages` itself:
   *  reactions are per-viewer and change far more often than the messages
   *  they're attached to (mirrors web's packages/app/src/lib/queryKeys.ts). */
  reactions: (conversationId: string) => ['reactions', conversationId] as const,
  directory: ['directory'] as const,
  myOrgs: ['myOrgs'] as const,
  notifications: ['notifications'] as const,
  tasksAssigned: ['tasksAssigned'] as const,
  tasksSent: ['tasksSent'] as const,
  taskDetail: (taskId: string) => ['taskDetail', taskId] as const,
  myCalls: ['myCalls'] as const,
  callHistory: ['callHistory'] as const,
  call: (callId: string) => ['call', callId] as const,
  /** Calendar window read (`myCallsInRange`); the bare prefix invalidates every cached month. */
  callsRangePrefix: ['callsRange'] as const,
  callsRange: (fromISO: string, toISO: string) => ['callsRange', fromISO, toISO] as const,
  channels: ['channels'] as const,
  openChannels: ['openChannels'] as const,
  channelMessages: (channelId: string) => ['channelMessages', channelId] as const,
  /** Channel twin of `qk.reactions` — same prefix-invalidation contract. */
  channelReactions: (channelId: string) => ['channelReactions', channelId] as const,
  channelRoster: (channelId: string) => ['channelRoster', channelId] as const,
  mailInbox: ['mailInbox'] as const,
  mailDetail: (mailId: string) => ['mailDetail', mailId] as const,
  presence: ['presence'] as const,
  activeSessions: ['activeSessions'] as const,
  mfaMethods: ['mfaMethods'] as const,
  activityTimeline: (userId: string, category: string) => ['activityTimeline', userId, category] as const,
  /** Admin roster: every membership INCLUDING suspended/removed (org_admin only). */
  members: ['members'] as const,
  /** Admin-only live roster (state / last seen / last login) from telemetry-svc. */
  activityRoster: ['activity', 'roster'] as const,
  activitySessions: (userId: string) => ['activity', 'sessions', userId] as const,
  activitySummary: (userId: string, from: string, to: string) => ['activity', 'summary', userId, from, to] as const,
  /** auth-svc sign-in sessions of one member (admin twin of `activeSessions`). */
  memberActiveSessions: (userId: string) => ['auth', 'sessions', userId] as const,
  /** Tamper-evident audit trail scoped to one member. */
  audit: (targetId: string) => ['audit', targetId] as const,
};
