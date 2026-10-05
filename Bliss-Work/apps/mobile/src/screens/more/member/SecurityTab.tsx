import { useMemo } from 'react';
import { ScrollText } from 'lucide-react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import type { AuditEntryDTO, MemberDTO } from '@taskboard/shared';
import { Avatar } from '../../../components/Avatar';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { ListEmpty } from '../../../components/QueryState';
import { qk } from '../../../hooks/queryKeys';
import { spacing, radius, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';
import { LoadMoreFooter } from './LoadMore';
import { InfoRow, isForbidden } from './memberUi';

// Same wording as web's MemberAuditLog — the only actions auth-svc audits.
const LABELS: Record<string, string> = {
  'org.created': 'created the workspace',
  'user.profile_updated': 'updated their profile',
  'invite.created': 'invited someone',
  'invite.accepted': 'accepted an invite',
  'invite.revoked': 'revoked an invite',
  'password.reset_requested': 'requested a password reset',
  'password.reset_completed': 'completed a password reset',
  'email.verified': 'verified their email',
  'member.role_changed': 'changed a role',
  'member.deactivated': 'deactivated a member',
  'member.reactivated': 'reactivated a member',
  'member.removed': 'removed a member',
};

/**
 * What auth-svc really knows about this member's security: whether the email
 * is verified (MemberDTO) and the audit trail scoped to them
 * (`GET /auth/audit?targetId=`, org_admin-only, cursor-paged). MFA state and
 * last-password-change are NOT exposed on any member endpoint, so they are not
 * shown. Sign-in sessions live on the Sessions tab; nothing here carries a
 * token, password or secret.
 */
export function SecurityTab({ member, members }: { member: MemberDTO; members: MemberDTO[] }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  // Full roster (incl. suspended/removed) so an actor who has since left still resolves to a name.
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const q = useInfiniteQuery({
    queryKey: qk.audit(member.id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.auditLog({ before: pageParam, targetId: member.id, limit: 30 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data]);

  return (
    <FlatList
      data={entries}
      keyExtractor={(e) => e.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.header}>
          <Card>
            <InfoRow label="Email verified" value={member.emailVerified ? 'Yes' : 'Not yet'} last />
          </Card>
          <Text style={styles.sectionTitle}>Audit trail</Text>
        </View>
      }
      ListEmptyComponent={
        <ListEmpty
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          onRetry={() => void q.refetch()}
          errorTitle={isForbidden(q.error) ? "You don't have permission to view the audit trail" : "Couldn't load the audit trail"}
          loadingLabel="Loading audit trail..."
          empty={<EmptyState icon={ScrollText} title="Nothing recorded yet" subtitle="Admin actions on this member will show up here." />}
        />
      }
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListFooterComponent={
        entries.length > 0 ? (
          <LoadMoreFooter hasNextPage={!!q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} onLoadMore={() => void q.fetchNextPage()} />
        ) : undefined
      }
      renderItem={({ item }) => <AuditRow colors={colors} entry={item} actor={item.actorId ? byId.get(item.actorId) : undefined} />}
    />
  );
}

function AuditRow({ colors, entry, actor }: { colors: ThemeColors; entry: AuditEntryDTO; actor?: MemberDTO }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const change = renderChange(entry.meta);
  return (
    <View style={styles.row}>
      <Avatar name={actor?.displayName ?? 'System'} src={actor?.avatarUrl} size={32} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>
          <Text style={styles.actor}>{actor?.displayName ?? 'System'}</Text> {LABELS[entry.action] ?? entry.action}
        </Text>
        <Text style={styles.meta}>{new Date(entry.at).toLocaleString()}</Text>
        {change ? (
          <View style={styles.change}>
            <Text style={styles.meta}>{change}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** `meta` is free-form jsonb; show only the from→to pair member actions write. */
function renderChange(meta: Record<string, unknown> | null): string | null {
  if (!meta || meta.to == null) return null;
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
  return meta.from != null ? `${fmt(meta.from)} → ${fmt(meta.to)}` : fmt(meta.to);
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'] },
    header: { gap: spacing.sm, marginBottom: spacing.sm },
    sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.fg, marginTop: spacing.xs },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTitle: { fontSize: 14, color: colors.fg },
    actor: { fontWeight: '600' },
    meta: { fontSize: 12, color: colors.muted },
    change: { alignSelf: 'flex-start', backgroundColor: colors.surface2, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  });
}
