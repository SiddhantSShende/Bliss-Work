import { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { Bell, Mail, Video, MessageCircle, Building2, ChevronDown, ChevronRight, CheckSquare } from 'lucide-react-native';
import type { UserDTO } from '@taskboard/shared';
import { displayNameOf } from '@taskboard/app/lib/userLabel';
import { useSession } from '@taskboard/app/store/session';
import { Logo } from '../../components/Logo';
import { GlassSurface } from '../../components/glass/GlassSurface';
import { Badge } from '../../components/Badge';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { useThemeColors } from '../../theme/ThemeProvider';
import { useMyOrgs } from '../../hooks/useMyOrgs';
import { useConversations } from '../../hooks/useConversations';
import { useNotifications } from '../../hooks/useNotifications';
import { useMailInbox } from '../../hooks/useMailInbox';
import { useMeetings } from '../../hooks/useMeetings';
import { useTasks } from '../../hooks/useTasks';
import { useDirectory } from '../../hooks/useDirectory';
import { useOpenDirectMessage } from '../../hooks/useOpenDirectMessage';
import { usePresence } from '../../hooks/usePresence';
import { useCalls } from '../../calls/CallProvider';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { RecentTaskCard, RECENT_TASK_CARD_HEIGHT } from './RecentTaskCard';
import { sameDay } from '../../lib/meetings';
import { isOutgoing } from '@taskboard/app/lib/mailView';
import { recentTasks, RECENT_TASKS_LIMIT } from '../../lib/recentTasks';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { AppTabParamList } from '../../navigation/types';
import { NotificationsSheet } from '../chats/NotificationsSheet';
import { MemberPreviewSheet } from './MemberPreviewSheet';
import { OrgSwitcherSheet } from '../../components/OrgSwitcherSheet';

const MEMBER_PREVIEW_LIMIT = 8;

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Home: a live snapshot of the signed-in user's workspace. Every figure comes
 * from the same queries the other tabs use (mail inbox, conversations, upcoming
 * calls, assigned tasks, notifications) and every tile/button navigates to the
 * screen that owns the data. Pull down to refresh everything.
 */
export function HomeDashboardScreen({ navigation }: any) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => StyleSheet.create(createStyles(colors)), [colors]);
  const user = useSession((s) => s.user);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [orgSwitcherOpen, setOrgSwitcherOpen] = useState(false);
  const [previewMember, setPreviewMember] = useState<UserDTO | null>(null);
  const { startDirectCall } = useCalls();

  const orgs = useMyOrgs();
  const conversations = useConversations();
  const notifications = useNotifications();
  const mail = useMailInbox();
  const { upcoming } = useMeetings();
  const { assigned } = useTasks();
  const directory = useDirectory('');
  const members = directory.all;
  const shownMembers = members.slice(0, MEMBER_PREVIEW_LIMIT);
  const online = usePresence(shownMembers.map((m) => m.id));

  const activeOrg = orgs.data?.find((o) => o.active) ?? orgs.data?.[0];
  const orgName = user?.orgName || activeOrg?.orgName || 'Workspace';
  // Only worth a switcher once there is something to switch between — a
  // single-org account keeps today's tap-through-to-More behavior unchanged.
  const canSwitchOrg = (orgs.data?.length ?? 0) > 1;

  const unreadChats = conversations.data?.reduce((sum, c) => sum + c.unread, 0) ?? 0;
  const unreadMails = mail.data?.pages.flatMap((p) => p.items).reduce((sum, it) => (isOutgoing(it) ? sum : sum + it.unreadCount), 0) ?? 0;
  const now = new Date();
  const meetingsToday = upcoming.data?.filter((c) => c.scheduledAt && sameDay(new Date(c.scheduledAt), now)).length ?? 0;
  const pendingTasks = assigned.data?.filter((t) => t.myStatus === 'SENT' || t.myStatus === 'ACKNOWLEDGED').length ?? 0;
  const notificationsUnread = notifications.data?.filter((n) => !n.read).length ?? 0;
  // Recent Tasks: the latest tasks assigned to me (the same query the Tasks tab reads), at most 5.
  const latestTasks = useMemo(() => recentTasks(assigned.data), [assigned.data]);

  const queries = [orgs, conversations, notifications, mail, upcoming, assigned];
  const refreshing = queries.some((q) => q.isRefetching && !q.isLoading);
  const allFailed = queries.every((q) => q.isError);
  const refresh = useCallback(() => {
    queries.forEach((q) => void q.refetch());
    void directory.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries, directory.refetch]);

  const tabs = () => navigation.getParent() as BottomTabNavigationProp<AppTabParamList> | undefined;
  const go = {
    org: () => tabs()?.navigate('More', { screen: 'MoreMenu' }),
    mail: () => tabs()?.navigate('Chats', { screen: 'ChatsList', params: { tab: 'mail' } }),
    meetings: () => tabs()?.navigate('Meetings', { screen: 'MeetingsList' }),
    chats: () => tabs()?.navigate('Chats', { screen: 'ChatsList', params: { tab: 'chats' } }),
    tasks: () => tabs()?.navigate('Tasks', { screen: 'TasksList' }),
    task: (taskId: string) => tabs()?.navigate('Tasks', { screen: 'TaskDetail', params: { taskId } }),
    compose: () => tabs()?.navigate('Chats', { screen: 'MailCompose' }),
    schedule: () => tabs()?.navigate('Meetings', { screen: 'ScheduleMeeting' }),
    newChat: () => tabs()?.navigate('Chats', { screen: 'NewChat' }),
    assign: () => tabs()?.navigate('Tasks', { screen: 'AssignTask' }),
  };

  const { open: openDm } = useOpenDirectMessage((conversationId, peerId) => {
    const peer = members.find((m) => m.id === peerId);
    const peerName = peer ? displayNameOf({ peerDisplayName: peer.displayName, peerUsername: peer.username }) : '';
    tabs()?.navigate('Chats', { screen: 'ChatConversation', params: { conversationId, peerId, peerName } });
  });
  const messageMember = (m: UserDTO) => {
    setPreviewMember(null);
    void openDm(m.id).catch(() => undefined);
  };
  const callMember = (m: UserDTO, media: 'audio' | 'video') => {
    setPreviewMember(null);
    startDirectCall(m.id, m.displayName, media);
  };

  const firstName = user?.displayName?.split(' ')[0] ?? '';

  const overview = [
    { key: 'mail', icon: Mail, value: unreadMails, label: 'Unread Mails', onPress: go.mail },
    { key: 'meet', icon: Video, value: meetingsToday, label: 'Meetings Today', onPress: go.meetings },
    { key: 'chat', icon: MessageCircle, value: unreadChats, label: 'Unread Chats', onPress: go.chats },
    { key: 'task', icon: CheckSquare, value: pendingTasks, label: 'Pending Tasks', onPress: go.tasks },
  ];
  const actions = [
    { key: 'mail', icon: Mail, label: 'Mail', onPress: go.compose },
    { key: 'meeting', icon: Video, label: 'Meeting', onPress: go.schedule },
    { key: 'chat', icon: MessageCircle, label: 'Chat', onPress: go.newChat },
    { key: 'task', icon: CheckSquare, label: 'Task', onPress: go.assign },
  ];

  const overviewRows = [overview.slice(0, 2), overview.slice(2, 4)];
  const tasksLoading = assigned.isLoading;
  const tasksFailed = assigned.isError && !assigned.data;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
      >
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Logo size={28} />
            <Text style={styles.logoText}>BlissWork</Text>
          </View>
          <Pressable style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Notifications" onPress={() => setNotificationsOpen(true)} hitSlop={4}>
            <Bell color={colors.fg} size={ICON} />
            {notificationsUnread > 0 ? (
              <View style={styles.bellBadge}>
                <Badge count={notificationsUnread} />
              </View>
            ) : null}
          </Pressable>
        </View>

        {allFailed ? (
          <ErrorState title="Unable to load your workspace" error={mail.error} onRetry={refresh} />
        ) : (
          <>
            <GlassSurface style={styles.fullWidth}>
              <Pressable
                style={({ pressed }) => [styles.workspaceInner, pressed && styles.workspaceCardPressed]}
                onPress={() => (canSwitchOrg ? setOrgSwitcherOpen(true) : go.org())}
                accessibilityRole="button"
                accessibilityLabel={canSwitchOrg ? 'Switch organization' : 'Workspace'}
              >
                <View style={styles.workspaceIcon}>
                  <Building2 color={colors.icon} size={ICON} />
                </View>
                <View style={styles.workspaceInfo}>
                  <Text style={styles.workspaceName} numberOfLines={1}>{orgName}</Text>
                  <Text style={styles.workspaceSub} numberOfLines={1}>
                    {orgs.data ? `${orgs.data.length} ${orgs.data.length === 1 ? 'organization' : 'organizations'}` : 'Loading...'}
                  </Text>
                </View>
                {canSwitchOrg ? <ChevronDown color={colors.muted} size={18} /> : <ChevronRight color={colors.muted} size={18} />}
              </Pressable>
            </GlassSurface>

            <OrgSwitcherSheet visible={orgSwitcherOpen} onClose={() => setOrgSwitcherOpen(false)} />

            <View style={styles.greetingSection}>
              <Text style={styles.greetingTitle} numberOfLines={2}>
                {greeting(now.getHours())}
                {firstName ? `, ${firstName}` : ''} 👋
              </Text>
              <Text style={styles.greetingSub}>Here's what's happening today</Text>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Today's Overview</Text>
              </View>
              {/* Two equal columns that fill the page width exactly, whatever the phone's width. */}
              {overviewRows.map((row, r) => (
                <View key={r} style={styles.gridRow}>
                  {row.map(({ key, icon: Icon, value, label, onPress }) => (
                    <GlassSurface key={key} style={styles.gridCell}>
                      <Pressable style={styles.overviewInner} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
                        <Icon color={colors.icon} size={ICON} />
                        <Text style={styles.overviewNumber}>{String(value).padStart(2, '0')}</Text>
                        <Text style={styles.overviewLabel} numberOfLines={1}>{label}</Text>
                      </Pressable>
                    </GlassSurface>
                  ))}
                </View>
              ))}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Quick Actions</Text>
              </View>
              <View style={styles.gridRow}>
                {actions.map(({ key, icon: Icon, label, onPress }) => (
                  <GlassSurface key={key} blur={false} style={styles.gridCell}>
                    <Pressable style={styles.actionInner} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
                      <Icon color={colors.icon} size={ICON} />
                      <Text style={styles.actionText} numberOfLines={1}>{label}</Text>
                    </Pressable>
                  </GlassSurface>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent Tasks</Text>
                {latestTasks.length > 0 ? (
                  <Pressable onPress={go.tasks} hitSlop={8} accessibilityRole="button" accessibilityLabel="View all tasks">
                    <Text style={styles.viewAll}>View all</Text>
                  </Pressable>
                ) : null}
              </View>
              {tasksLoading ? (
                <GlassSurface blur={false} style={[styles.fullWidth, styles.taskPlaceholder]}>
                  <LoadingState label="Loading tasks..." />
                </GlassSurface>
              ) : tasksFailed ? (
                <GlassSurface blur={false} style={[styles.fullWidth, styles.taskPlaceholder]}>
                  <ErrorState title="Unable to load tasks" error={assigned.error} onRetry={() => void assigned.refetch()} />
                </GlassSurface>
              ) : latestTasks.length === 0 ? (
                <GlassSurface blur={false} style={[styles.fullWidth, styles.taskPlaceholder]}>
                  <EmptyState icon={CheckSquare} title="No recent tasks" />
                </GlassSurface>
              ) : (
                latestTasks.map((t) => <RecentTaskCard key={t.taskId} task={t} onPress={go.task} />)
              )}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Members</Text>
                {members.length > MEMBER_PREVIEW_LIMIT ? (
                  <Pressable onPress={() => tabs()?.navigate('More', { screen: 'Members' })} hitSlop={8}>
                    <Text style={styles.viewAll}>See all ({members.length})</Text>
                  </Pressable>
                ) : null}
              </View>
              <GlassSurface style={[styles.fullWidth, styles.listCard]}>
                {directory.isLoading ? (
                  <LoadingState label="Loading members..." />
                ) : directory.isError && members.length === 0 ? (
                  <ErrorState title="Unable to load members" error={directory.error} onRetry={() => void directory.refetch()} />
                ) : shownMembers.length === 0 ? (
                  <Text style={styles.emptyText}>No other members in this workspace yet.</Text>
                ) : (
                  shownMembers.map((m, i) => (
                    <Pressable
                      key={m.id}
                      onPress={() => setPreviewMember(m)}
                      style={[styles.memberRow, i > 0 && styles.memberDivider]}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${m.displayName}`}
                    >
                      <Avatar name={m.displayName} src={m.avatarUrl} size={40} online={online.has(m.id)} />
                      <View style={styles.memberText}>
                        <Text style={styles.memberName} numberOfLines={1}>{m.displayName}</Text>
                        <Text style={styles.memberMeta} numberOfLines={1}>
                          {m.roles.includes('org_admin') ? 'Admin' : 'Member'} · {online.has(m.id) ? 'Online' : 'Offline'}
                        </Text>
                      </View>
                      <ChevronRight color={colors.muted} size={16} />
                    </Pressable>
                  ))
                )}
              </GlassSurface>
            </View>
          </>
        )}
      </ScrollView>

      <MemberPreviewSheet
        member={previewMember}
        online={previewMember ? online.has(previewMember.id) : false}
        onClose={() => setPreviewMember(null)}
        onMessage={messageMember}
        onCall={callMember}
      />

      <NotificationsSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </View>
  );
}

/** Size of every icon on this screen, and the touch target the bell sits in. */
const ICON = 22;
const TOUCH = 44;
/** One rhythm for the whole page: the gap between sections, and between a section's title and its content. */
const SECTION_GAP = spacing.xl;
const ITEM_GAP = spacing.md;

function createStyles(colors: ThemeColors) {
  return {
    container: { flex: 1, backgroundColor: 'transparent' },
    // One left/right boundary for everything: the page padding. Every block below is full width inside it.
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: SECTION_GAP },
    fullWidth: { alignSelf: 'stretch' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: TOUCH },
    logoContainer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    logoText: { fontSize: 20, fontWeight: '700', color: colors.fg },
    // The bell sits in a 44dp target; pulled out by the icon's inset so the ICON (not its invisible
    // target) lines up with the cards' right edge.
    iconButton: { width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center', marginRight: -(TOUCH - ICON) / 2 },
    bellBadge: { position: 'absolute', top: 4, right: 2 },
    workspaceInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
    workspaceIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.accentSoft, justifyContent: 'center', alignItems: 'center' },
    workspaceInfo: { flex: 1, minWidth: 0 },
    workspaceName: { color: colors.fg, fontSize: 16, fontWeight: '600' },
    workspaceSub: { marginTop: 2, color: colors.muted, fontSize: 13 },
    workspaceCardPressed: { opacity: 0.85 },
    greetingSection: { gap: 4 },
    greetingTitle: { color: colors.fg, fontSize: 24, fontWeight: '700' },
    greetingSub: { color: colors.muted, fontSize: 14 },
    section: { gap: ITEM_GAP },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 24 },
    sectionTitle: { color: colors.fg, fontSize: 18, fontWeight: '700' },
    viewAll: { color: colors.accent, fontSize: 14, fontWeight: '600' },
    // Rows of equal-width cells that exactly fill the page width (flex, not a percentage + gap that leaves a ragged right edge).
    gridRow: { flexDirection: 'row', gap: ITEM_GAP },
    gridCell: { flex: 1, minWidth: 0 },
    overviewInner: { padding: spacing.lg, minHeight: 116 },
    overviewNumber: { color: colors.fg, fontSize: 24, fontWeight: '700', marginTop: spacing.md },
    overviewLabel: { color: colors.muted, fontSize: 13, marginTop: 2 },
    actionInner: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg, paddingHorizontal: spacing.xs },
    actionText: { color: colors.fg, fontSize: 13, fontWeight: '600' },
    // Same height whether it holds a spinner, an error or the empty message, so the page does not jump when tasks arrive.
    taskPlaceholder: { minHeight: RECENT_TASK_CARD_HEIGHT, justifyContent: 'center' },
    listCard: { padding: spacing.md },
    emptyText: { color: colors.muted, fontSize: 14, textAlign: 'center', paddingVertical: spacing.md },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    memberDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: spacing.md, paddingTop: spacing.md },
    memberText: { flex: 1, minWidth: 0 },
    memberName: { color: colors.fg, fontSize: 14, fontWeight: '600' },
    memberMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  } as const;
}
