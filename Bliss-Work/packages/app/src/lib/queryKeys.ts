/** Canonical TanStack Query keys. Platform-neutral; do not import React Router here. */
export const qk = {
  conversations: ["conversations"] as const,
  messages: (id: string) => ["messages", id] as const,
  /** Reaction tallies for a conversation. Kept OFF the message list: the tally
   *  is per-viewer and changes far more often than the messages do, so folding
   *  it in would invalidate the whole thread on every tap. */
  reactions: (id: string) => ["reactions", id] as const,
  inbox: ["tasks", "inbox"] as const,
  sent: ["tasks", "sent"] as const,
  sticky: ["tasks", "sticky"] as const,
  assigned: ["tasks", "assigned"] as const,
  /** Inputs for the "Available" bucket (open-task counts + admin-hidden set).
   *  POLLED, not pushed — see the note in useAvailability. */
  availability: ["tasks", "availability"] as const,
  /** Every visible task's chat target + unread count, bulk-fetched — the
   *  "Chat"/"Comments N" badge on sticky widgets and task rows. A ROOT key
   *  (not parameterized per task) since the client always fetches the whole
   *  visible task list's discussions in one call. */
  taskDiscussions: ["tasks", "discussions"] as const,
  /** Calls the caller is expected at, including cross-org meetings. */
  calls: ["calls"] as const,
  call: (id: string) => ["calls", id] as const,
  /** Every call overlapping a calendar window. UNDER the ["calls"] prefix on
   *  purpose — unlike callHistory below, this is one bounded page per window
   *  rather than an infinite query, so being swept up by the same invalidation
   *  every other call surface gets is exactly what keeps the calendar live when
   *  somebody schedules, starts or ends a meeting. */
  callsRange: (fromISO: string, toISO: string) => ["calls", "range", fromISO, toISO] as const,
  /** A repeating meeting's series, for its organiser's edit form. Under the
   *  ["calls"] prefix for the same reason as callsRange: an edit, a cancel or the
   *  server topping the series up changes what it holds, and every call event
   *  already sweeps that prefix. */
  meetingSeries: (id: string) => ["calls", "series", id] as const,
  /** The signed playback link for one call's recording. Its own key, not part
   *  of the call, because the link EXPIRES and is refetched on a timer while
   *  the call row itself does not change. */
  callRecording: (callId: string) => ["calls", callId, "recording"] as const,
  /** Finished meetings, keyset-paged.
   *
   *  A ROOT key of its own, deliberately not under ["calls"]. Everything under
   *  that prefix is invalidated together on every call event, and this is an
   *  infinite query — invalidating it refetches every page already scrolled
   *  into, so a user who had paged back through a year of meetings would
   *  re-download all of it each time somebody in the org joined a call.
   *
   *  It is invalidated explicitly on the one event that actually changes it: a
   *  call ending is what moves a meeting into Past. See the CallEnded case. */
  callHistory: ["callHistory"] as const,
  /** A finished meeting's chat transcript and shared notes. Separate keys
   *  because they are separate endpoints with separate cursors, and a meeting
   *  can easily have one and not the other. */
  callChat: (callId: string) => ["calls", callId, "chat"] as const,
  callNotes: (callId: string) => ["calls", callId, "notes"] as const,
  /** Calls scheduled or live in one channel. */
  channelCalls: (channelId: string) => ["channelCalls", channelId] as const,
  directory: ["directory"] as const,
  /** Specific people, resolved by id through the GraphQL gateway. Deliberately
   *  NOT under ["directory"]: that key holds "everyone in the org" and a
   *  partial result written there would be read as the whole directory by the
   *  pickers and mention lists that share it. */
  usersByIds: (ids: readonly string[]) => ["usersByIds", ids.join(",")] as const,
  /** Admin roster: every membership INCLUDING suspended/removed ones. Kept off
   *  the ["directory"] key so the admin screen's inactive rows can never leak
   *  into the pickers and mention lists that read the plain directory. */
  members: ["members"] as const,
  /** The org's tamper-evident audit trail. `targetId` scopes it to one member's
   *  Security tab; the bare prefix is the org-wide log. */
  audit: (targetId?: string) => ["audit", targetId ?? "all"] as const,
  // ── Member activity record (telemetry-svc) ───────────────────────────────
  // `userId` is part of every key, and "me" is a valid value the server
  // resolves to the caller — so a member's own view and an admin's view of
  // that member never share a cache entry, and the two can never bleed.
  activityRoster: ["activity", "roster"] as const,
  activityTimeline: (userId: string) => ["activity", "timeline", userId] as const,
  activitySessions: (userId: string) => ["activity", "sessions", userId] as const,
  activitySummary: (userId: string, from: string, to: string) =>
    ["activity", "summary", userId, from, to] as const,
  orgActivitySummary: (from: string, to: string) =>
    ["activity", "org", from, to] as const,
  // ── Active (sign-in) sessions — distinct from activitySessions above,
  // which is telemetry-svc's presence record. These are auth-svc's
  // refresh-token families: GET /auth/sessions and its admin twin.
  activeSessions: ["auth", "sessions"] as const,
  memberActiveSessions: (userId: string) => ["auth", "sessions", userId] as const,
  invites: ["invites"] as const,
  presence: ["presence"] as const,
  /** Who is in a live call right now — the "Busy" half of a person's status.
   *  Separate from `presence` because it has a different source (messaging-svc,
   *  from the call rows) and a different lifetime. */
  onCall: ["onCall"] as const,
  /** The panel's UNREAD feed (server-filtered). */
  notifications: ["notifications"] as const,
  /** The panel's READ feed — fetched separately so unread rows are never
   *  hidden behind pages of read ones. */
  notificationsRead: ["notifications", "read"] as const,
  /** Bounded IDs used to suppress replayed notification.created frames when
   *  the corresponding row is not in the currently loaded pages. */
  notificationEventIds: ["notifications", "realtimeIds"] as const,
  /** The bell badge count alone — see api.notificationsUnreadCount(). Separate
   *  key from `notifications` (the full list) so the badge and the opened
   *  panel are independent cache entries with independent lifetimes. */
  notificationsUnreadCount: ["notifications", "unreadCount"] as const,
  /** Sidebar badge totals (conversations/channels/inboxPeers unread) in one
   *  entry — see api.unreadCounts(). Independent of `conversations`/
   *  `channels`/`inboxPeers` (the full lists each section's own list pane
   *  fetches on open) for the same reason as notificationsUnreadCount above. */
  unreadCounts: ["unreadCounts"] as const,
  channels: ["channels"] as const,
  openChannels: ["channels", "open"] as const,
  channelMessages: (id: string) => ["channelMessages", id] as const,
  channelReadReceipts: (id: string) => ["channelReadReceipts", id] as const,
  /** Reaction tallies for one channel. Kept OFF the message list for the same
   *  reason `reactions` is: the tally is per-viewer and changes far more often
   *  than the messages, so folding it in would invalidate the whole channel on
   *  every tap. */
  channelReactions: (id: string) => ["channelReactions", id] as const,
  /** Members of ONE channel WITH their roles. Separate from the bare member-id
   *  list the task dialog reads, which must keep its string[] shape. */
  channelRoster: (id: string) => ["channelRoster", id] as const,
  // ── Phase 4: unified inbox + email-style threads ─────────────────────────
  unifiedInbox: ["unifiedInbox"] as const,
  unifiedInboxUnread: ["unifiedInbox", "unread"] as const,
  /** People sidebar of the inbox: distinct counterparties + rollups. */
  inboxPeers: ["inboxPeers"] as const,
  /** Per-person filtered inbox feed. Kept in a namespace separate from
   *  `unifiedInbox` so the all-feed's optimistic patches (which target the
   *  exact `unifiedInbox` key) are never disturbed by peer drill-downs. */
  inboxPeerFeed: (peerId: string) => ["inboxPeerFeed", peerId] as const,
  thread: (id: string) => ["thread", id] as const,
  threadMessages: (id: string) => ["threadMessages", id] as const,
  /** One complete email. Fetched only when a MAIL row is opened — the feed row
   *  itself comes from `unifiedInbox` and carries no body. */
  mail: (id: string) => ["mail", id] as const,
  /** Deleted Items: the same feed as `unifiedInbox`, read with its visibility
   *  predicate inverted. Its OWN namespace rather than a suffix on
   *  `unifiedInbox`, because lib/inboxPatch writes that key with an exact-key
   *  setQueryData and a deleted row landing in those patches would put mail
   *  back in the mailbox it was just removed from. */
  deletedMail: ["deletedMail"] as const,
  /** The Drafts folder — unsent mail, from its own listing rather than the
   *  feed. A draft is in nobody's inbox_items, so there is no feed row to
   *  patch and nothing here shares a namespace with one. */
  mailDrafts: ["mailDrafts"] as const,
  /** Organizations the signed-in identity belongs to (org switcher). */
  myOrgs: ["myOrgs"] as const,
  myOrgsPage: (search: string) => ["myOrgs", "page", search] as const,
  /** The current org plus any pending deletion (admin-only). */
  org: ["org"] as const,
  /** The org's mandatory-MFA-for-admins policy + grace-period deadline (admin-only). */
  orgMfaSettings: ["orgMfaSettings"] as const,
  /** Task ids pinned to the desktop (Electron-only; empty on web). */
  taskPins: ["taskPins"] as const,
  /** The user's pin / explicit-unpin choice per task, from sticky-svc — the
   *  shared state Web and Desktop both follow (see lib/stickyPinState). */
  stickyPinStates: ["stickyPinStates"] as const,
};
