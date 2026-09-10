import { useMemo, useState } from 'react';
import { ArrowLeft, Laptop, MonitorSmartphone } from 'lucide-react-native';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { ApiError, decodeJwtPayload, type ActiveSessionDTO } from '@taskboard/shared';
import { signOut } from '../../services/auth';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { qk } from '../../hooks/queryKeys';
import { timeAgo } from '../../lib/timeAgo';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ActiveSessions'>;

/**
 * Mirrors packages/app/src/routes/ActiveSessions.tsx (web): list every
 * signed-in session, sign one out remotely, or sign out every OTHER
 * session. "Which row is this device" is decided the same way web does it —
 * decoding the `sid` claim out of the access token client-side
 * (`decodeJwtPayload`), no signature check, informational only — rather than
 * a server-side flag, since only web reliably sends the refresh cookie a
 * server-side check would need.
 */
export function ActiveSessionsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const accessToken = useSession((s) => s.accessToken);
  const qc = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const currentSessionId = useMemo(() => decodeJwtPayload<{ sid?: string }>(accessToken)?.sid ?? null, [accessToken]);

  const { data: sessions, isLoading } = useQuery({
    queryKey: qk.activeSessions,
    queryFn: () => api.listSessions(),
  });

  const revokeOne = async (session: ActiveSessionDTO) => {
    if (session.id === currentSessionId) {
      // Ends up as a full sign-out (/auth/logout), not a bare session
      // revoke — same as web's ActiveSessions.tsx for the identical reason:
      // revoking your OWN current session has to also clear local state.
      await signOut(api);
      return;
    }
    setRevokingId(session.id);
    try {
      await api.revokeSession(session.id);
      qc.setQueryData<ActiveSessionDTO[]>(qk.activeSessions, (prev) => (prev ?? []).filter((s) => s.id !== session.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await qc.invalidateQueries({ queryKey: qk.activeSessions });
      } else {
        Alert.alert("Couldn't sign out that session", 'Please try again.');
      }
    } finally {
      setRevokingId(null);
    }
  };

  const confirmRevoke = (session: ActiveSessionDTO) => {
    if (session.id === currentSessionId) {
      Alert.alert('Sign out this device?', 'You will be signed out immediately.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void revokeOne(session) },
      ]);
      return;
    }
    Alert.alert('Sign out this session?', `${session.device} will be signed out immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void revokeOne(session) },
    ]);
  };

  const revokeAllOthers = async () => {
    try {
      const revokedIds = await api.revokeOtherSessions(currentSessionId ?? undefined);
      qc.setQueryData<ActiveSessionDTO[]>(qk.activeSessions, (prev) => (prev ?? []).filter((s) => !revokedIds.includes(s.id)));
    } catch {
      Alert.alert("Couldn't sign out other sessions", 'Please try again.');
      await qc.invalidateQueries({ queryKey: qk.activeSessions });
    }
  };

  const others = (sessions ?? []).filter((s) => s.id !== currentSessionId);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Active sessions</Text>
        <View style={{ width: 22 }} />
      </View>

      <FlatList
        data={sessions ?? []}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !isLoading ? <EmptyState icon={MonitorSmartphone} title="No active sessions" subtitle="You'll see every signed-in device here." /> : null
        }
        ListFooterComponent={
          others.length > 0 ? (
            <Pressable
              onPress={() =>
                Alert.alert('Sign out of all other sessions?', `This device stays signed in. ${others.length} other session${others.length === 1 ? '' : 's'} will be signed out.`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out others', style: 'destructive', onPress: () => void revokeAllOthers() },
                ])
              }
              style={styles.revokeAllBtn}
            >
              <Text style={styles.revokeAllBtnText}>Sign out of all other sessions</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => {
          const isCurrent = item.id === currentSessionId;
          return (
            <Card style={styles.row}>
              <Laptop size={18} color={colors.muted} style={{ marginTop: 2 }} />
              <View style={styles.rowText}>
                <View style={styles.rowTop}>
                  <Text style={styles.device}>{item.device}</Text>
                  {isCurrent ? (
                    <View style={styles.currentBadge}>
                      <Text style={styles.currentBadgeText}>This device</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.meta}>
                  Active {timeAgo(item.lastSeenAt)} · Signed in {timeAgo(item.createdAt)}
                  {item.approxLocation ? ` · ${item.approxLocation}` : ''}
                </Text>
              </View>
              <Button
                title="Sign out"
                variant={isCurrent ? 'primary' : 'ghost'}
                loading={revokingId === item.id}
                disabled={revokingId !== null && revokingId !== item.id}
                onPress={() => confirmRevoke(item)}
                style={styles.signOutBtn}
              />
            </Card>
          );
        }}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    list: { padding: spacing.lg, gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.sm },
    rowText: { flex: 1, gap: 2 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    device: { fontSize: 14, fontWeight: '600', color: colors.fg },
    meta: { fontSize: 12, color: colors.muted },
    currentBadge: { backgroundColor: colors.accentSoft, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
    currentBadgeText: { fontSize: 11, fontWeight: '700', color: colors.accent },
    signOutBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.pill },
    revokeAllBtn: { alignSelf: 'flex-end', paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
    revokeAllBtnText: { fontSize: 13, fontWeight: '600', color: colors.accent },
  });
}
