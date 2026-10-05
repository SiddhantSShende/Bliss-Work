import { useMemo, useState } from 'react';
import { Laptop, MonitorSmartphone } from 'lucide-react-native';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { formatDuration } from '@taskboard/app/features/member/activityLabels';
import { ApiError, type ActiveSessionDTO, type ActivitySessionDTO, type MemberDTO } from '@taskboard/shared';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState, LoadingState } from '../../../components/QueryState';
import { qk } from '../../../hooks/queryKeys';
import { timeAgo } from '../../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';
import { LoadMoreFooter } from './LoadMore';
import { ActionButton, Pill, isForbidden } from './memberUi';

const END_REASON: Record<string, string> = { disconnect: 'Closed the app', timeout: 'Went quiet' };

/**
 * Two different things share the word "session", and the backend keeps them
 * apart, so this tab does too:
 *  - Sign-in sessions (auth-svc, `GET /auth/members/{id}/sessions`): the
 *    refresh-token families that can actually be revoked. Not paged by the
 *    server — a person has a handful. Hidden for yourself: the server refuses
 *    self-revoke (409), and your own are managed in Privacy & Security.
 *  - Activity sessions (telemetry-svc, cursor-paged): device, start/end,
 *    active vs idle time. Read-only.
 * Neither carries tokens or secrets; `device`/`approxLocation`/`ipPrefix` are
 * already coarsened server-side.
 */
export function SessionsTab({ member, subject, isSelf }: { member: MemberDTO; subject: string; isSelf: boolean }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();

  const q = useInfiniteQuery({
    queryKey: qk.activitySessions(subject),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.activitySessions(subject, { cursor: pageParam, limit: 20 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const sessions = useMemo(() => q.data?.pages.flatMap((p) => p.sessions) ?? [], [q.data]);

  return (
    <FlatList
      data={sessions}
      keyExtractor={(s) => s.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.header}>
          {isSelf ? (
            <Card>
              <Text style={styles.hint}>Your own sign-in sessions are managed under Privacy & Security → Active sessions.</Text>
            </Card>
          ) : (
            <SignInSessions member={member} />
          )}
          <Text style={styles.sectionTitle}>Activity sessions</Text>
        </View>
      }
      ListEmptyComponent={
        q.isLoading ? (
          <LoadingState label="Loading sessions..." />
        ) : q.isError ? (
          <ErrorState
            title={isForbidden(q.error) ? "You don't have permission to view these sessions" : "Couldn't load sessions"}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <EmptyState icon={MonitorSmartphone} title="No sessions recorded" subtitle="Sessions appear here once they sign in from a device." />
        )
      }
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListFooterComponent={
        sessions.length > 0 ? (
          <LoadMoreFooter
            hasNextPage={!!q.hasNextPage}
            isFetchingNextPage={q.isFetchingNextPage}
            onLoadMore={() => void q.fetchNextPage()}
            endNote="Showing the last 7 days. Older sessions are retained but not browsable here."
          />
        ) : undefined
      }
      renderItem={({ item }) => <ActivitySessionRow colors={colors} session={item} />}
    />
  );
}

function SignInSessions({ member }: { member: MemberDTO }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const q = useQuery({ queryKey: qk.memberActiveSessions(member.id), queryFn: () => api.listMemberSessions(member.id) });

  const revoke = async (s: ActiveSessionDTO) => {
    setRevokingId(s.id);
    try {
      await api.revokeMemberSession(member.id, s.id);
      qc.setQueryData<ActiveSessionDTO[]>(qk.memberActiveSessions(member.id), (prev) => (prev ?? []).filter((x) => x.id !== s.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await qc.invalidateQueries({ queryKey: qk.memberActiveSessions(member.id) });
      } else {
        Alert.alert("Couldn't sign out that session", 'Please try again.');
      }
    } finally {
      setRevokingId(null);
    }
  };

  const confirm = (s: ActiveSessionDTO) =>
    Alert.alert('Sign out this session?', `${s.device} will be signed out immediately and will need to sign in again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: () => void revoke(s) },
    ]);

  return (
    <View style={styles.signIn}>
      <Text style={styles.sectionTitle}>Signed-in devices</Text>
      {q.isLoading ? (
        <LoadingState label="Loading..." />
      ) : q.isError ? (
        <ErrorState title="Couldn't load signed-in devices" error={q.error} onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <Card>
          <Text style={styles.hint}>No active sessions.</Text>
        </Card>
      ) : (
        (q.data ?? []).map((s) => (
          <Card flat key={s.id} style={styles.rowCard}>
            <Laptop size={18} color={colors.muted} style={{ marginTop: 2 }} />
            <View style={styles.rowText}>
              <View style={styles.rowTop}>
                <Text style={styles.device} numberOfLines={1}>
                  {s.device}
                </Text>
                <Pill label="Active" tone="success" />
              </View>
              <Text style={styles.meta}>
                Active {timeAgo(s.lastSeenAt)} · Signed in {timeAgo(s.createdAt)}
                {s.approxLocation ? ` · ${s.approxLocation}` : ''}
              </Text>
            </View>
            <ActionButton title={revokingId === s.id ? '...' : 'Sign out'} danger disabled={revokingId !== null} onPress={() => confirm(s)} />
          </Card>
        ))
      )}
    </View>
  );
}

function ActivitySessionRow({ colors, session: s }: { colors: ThemeColors; session: ActivitySessionDTO }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const live = !s.endedAt;
  const start = new Date(s.startedAt);
  const end = s.endedAt ? new Date(s.endedAt) : null;
  const total = formatDuration((end ?? new Date()).getTime() - start.getTime());
  const active = formatDuration(s.activeMs);
  const idle = formatDuration(s.idleMs);
  return (
    <Card flat style={styles.rowCard}>
      <Laptop size={16} color={colors.muted} style={{ marginTop: 2 }} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.device} numberOfLines={1}>
            {s.deviceLabel}
          </Text>
          {live ? <Pill label="Active now" tone="success" /> : <Pill label={END_REASON[s.endReason ?? ''] ?? s.endReason ?? 'Ended'} />}
        </View>
        <Text style={styles.meta}>
          {start.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {end ? ` – ${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}
        </Text>
        <Text style={styles.meta}>
          {[total && `${total} total`, active && `${active} active`, idle && `${idle} idle`, s.ipPrefix].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Card>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'] },
    header: { gap: spacing.sm, marginBottom: spacing.sm },
    signIn: { gap: spacing.sm },
    sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.fg, marginTop: spacing.xs },
    hint: { fontSize: 13, color: colors.muted },
    rowCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.sm },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    device: { fontSize: 14, fontWeight: '600', color: colors.fg, flexShrink: 1 },
    meta: { fontSize: 12, color: colors.muted },
  });
}
