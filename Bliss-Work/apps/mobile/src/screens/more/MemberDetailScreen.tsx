import { useMemo, useState } from 'react';
import { ArrowLeft, ShieldOff, Users } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSession } from '@taskboard/app/store/session';
import { useIsOrgAdmin } from '../../hooks/useIsOrgAdmin';
import { useMemberRoster } from '../../hooks/useMemberRoster';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ActivityTab } from './member/ActivityTab';
import { AdminTab } from './member/AdminTab';
import { AnalyticsTab } from './member/AnalyticsTab';
import { OverviewTab } from './member/OverviewTab';
import { SecurityTab } from './member/SecurityTab';
import { SessionsTab } from './member/SessionsTab';
import { Pill, isForbidden, roleLabel, statusLabel, statusTone } from './member/memberUi';

type Props = NativeStackScreenProps<MoreStackParamList, 'MemberDetail'>;
type TabKey = 'overview' | 'activity' | 'analytics' | 'sessions' | 'admin' | 'security';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'admin', label: 'Admin' },
  { key: 'security', label: 'Security' },
];

/**
 * One member's details, for workspace admins only.
 *
 * Mirrors web's MemberDetail.tsx. Access is layered: the role check below
 * keeps a non-admin who navigates here directly (deep link, stale route) from
 * ever mounting a tab — and, more importantly, from firing any query — while
 * the actual control is the server: /auth/members*, /auth/audit and
 * /telemetry/members/{other} all refuse a non-admin token. A 403 from any of
 * them lands in the "no permission" state rather than a retry loop.
 *
 * Only the active tab is mounted, so Activity/Analytics/Sessions/Security
 * fetch nothing until opened; React Query keeps what was already loaded.
 */
export function MemberDetailScreen({ navigation, route }: Props) {
  const { userId } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const isAdmin = useIsOrgAdmin();
  const me = useSession((s) => s.user);
  const [tab, setTab] = useState<TabKey>('overview');
  const { members, activityById } = useMemberRoster(isAdmin);

  const member = members.data?.find((m) => m.id === userId);
  const isSelf = userId === me?.id;
  // "me" lets the server resolve the subject to the caller — the same
  // convention web's MemberDetail uses for an admin looking at themselves.
  const subject = isSelf ? 'me' : userId;

  const back = (
    <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
      <ArrowLeft size={22} color={colors.fg} />
    </Pressable>
  );

  const shell = (body: React.ReactNode) => (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>{back}</View>
      {body}
    </View>
  );

  if (!isAdmin) {
    return shell(
      <EmptyState icon={ShieldOff} title="Admins only" subtitle="Member details and activity are only available to workspace admins." />,
    );
  }
  if (members.isLoading) return shell(<LoadingState label="Loading member..." />);
  if (members.isError) {
    return shell(
      isForbidden(members.error) ? (
        <EmptyState icon={ShieldOff} title="No permission" subtitle="Your account isn't allowed to view member details." />
      ) : (
        <ErrorState title="Couldn't load member" error={members.error} onRetry={() => void members.refetch()} />
      ),
    );
  }
  if (!member) return shell(<EmptyState icon={Users} title="Member not found" />);

  const live = activityById.get(member.id);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>{back}</View>

      <View style={styles.hero}>
        <Avatar name={member.displayName} src={member.avatarUrl} size={56} />
        <View style={styles.heroText}>
          <Text style={styles.name} numberOfLines={1}>
            {member.displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            @{member.username}
          </Text>
          <View style={styles.pills}>
            <Pill label={roleLabel(member.roles)} tone={member.roles.includes('org_admin') ? 'accent' : 'neutral'} />
            <Pill label={statusLabel(member.status)} tone={statusTone(member.status)} />
            {member.status === 'active' && live ? (
              <Pill label={live.state === 'online' ? 'Online' : live.state === 'idle' ? 'Idle' : 'Offline'} tone={live.state === 'online' ? 'success' : 'neutral'} />
            ) : null}
          </View>
        </View>
      </View>

      {/* The tab strip is the ONLY horizontally scrolling element on the page.
          flexGrow: 0 stops the ScrollView claiming the body's vertical space. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll} contentContainerStyle={styles.tabRow}>
        {TABS.map((t) => (
          <Chip key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
        ))}
      </ScrollView>

      <View style={styles.body}>
        {tab === 'overview' ? <OverviewTab member={member} activity={live} isSelf={isSelf} /> : null}
        {tab === 'activity' ? <ActivityTab subject={subject} /> : null}
        {tab === 'analytics' ? <AnalyticsTab subject={subject} /> : null}
        {tab === 'sessions' ? <SessionsTab member={member} subject={subject} isSelf={isSelf} /> : null}
        {tab === 'admin' ? <AdminTab member={member} isSelf={isSelf} /> : null}
        {tab === 'security' ? <SecurityTab member={member} members={members.data ?? []} /> : null}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    topBar: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center' },
    hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    heroText: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontSize: 18, fontWeight: '700', color: colors.fg },
    username: { fontSize: 13, color: colors.muted },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    tabScroll: { flexGrow: 0, flexShrink: 0 },
    tabRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm },
    body: { flex: 1 },
  });
}
