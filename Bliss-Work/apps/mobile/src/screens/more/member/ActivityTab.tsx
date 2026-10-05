import { useMemo, useState } from 'react';
import { Activity, ShieldCheck } from 'lucide-react-native';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import type { TimelineEntry } from '@taskboard/shared';
import { actionLabel, dayHeading, formatDuration, sourceLabel } from '@taskboard/app/features/member/activityLabels';
import { Chip } from '../../../components/Chip';
import { EmptyState } from '../../../components/EmptyState';
import { ListEmpty } from '../../../components/QueryState';
import { qk } from '../../../hooks/queryKeys';
import { radius, spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';
import { LoadMoreFooter } from './LoadMore';
import { isForbidden } from './memberUi';

type Filter = 'all' | 'engagement' | 'navigation' | 'auth' | 'security';

/** The categories telemetry-svc's timeline endpoint accepts (`category=`) —
 *  the same set web's MemberTimeline offers. It has no messages/tasks/meetings/
 *  files split and no date-range parameter (the server floors every query to
 *  its 7-day visibility window), so those filters are deliberately absent. */
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'engagement', label: 'Work' },
  { key: 'navigation', label: 'In-app' },
  { key: 'auth', label: 'Sign-ins' },
  { key: 'security', label: 'Security' },
];

type Row = { type: 'heading'; key: string; heading: string } | { type: 'entry'; key: string; entry: TimelineEntry };

/** One member's timeline, newest first, grouped by day, cursor-paged 30 at a time. */
export function ActivityTab({ subject }: { subject: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const [filter, setFilter] = useState<Filter>('all');

  const q = useInfiniteQuery({
    queryKey: qk.activityTimeline(subject, filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.activityTimeline(subject, { cursor: pageParam, limit: 30, category: filter === 'all' ? undefined : filter }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => groupByDay(q.data?.pages.flatMap((p) => p.entries) ?? []), [q.data]);

  return (
    <View style={styles.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <ListEmpty
            isLoading={q.isLoading}
            isError={q.isError}
            error={q.error}
            onRetry={() => void q.refetch()}
            errorTitle={isForbidden(q.error) ? "You don't have permission to view this activity" : "Couldn't load activity"}
            loadingLabel="Loading activity..."
            empty={<EmptyState icon={Activity} title="No activity found" subtitle="Activity appears here as they use BlissWork." />}
          />
        }
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          rows.length > 0 ? (
            <LoadMoreFooter
              hasNextPage={!!q.hasNextPage}
              isFetchingNextPage={q.isFetchingNextPage}
              onLoadMore={() => void q.fetchNextPage()}
              endNote="Showing the last 7 days. Older activity is retained but not browsable here."
            />
          ) : undefined
        }
        renderItem={({ item }) =>
          item.type === 'heading' ? <Text style={styles.dayHeading}>{item.heading}</Text> : <EntryRow colors={colors} entry={item.entry} />
        }
      />
    </View>
  );
}

function EntryRow({ colors, entry }: { colors: ThemeColors; entry: TimelineEntry }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const src = sourceLabel(entry.source);
  const duration = formatDuration(entry.durationMs);
  const preview = entry.detail?.preview;
  return (
    <View style={styles.entryRow}>
      <Text style={styles.entryTime}>{new Date(entry.occurredAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</Text>
      <View style={styles.entryText}>
        <View style={styles.entryTop}>
          <Text style={styles.entryLabel}>{actionLabel(entry)}</Text>
          {duration ? (
            <View style={styles.durationBadge}>
              <Text style={styles.durationBadgeText}>{duration}</Text>
            </View>
          ) : null}
          {/* Server-observed rows are the only ones a client can't forge. */}
          {src.verified ? <ShieldCheck size={13} color={colors.success} /> : null}
        </View>
        {preview ? (
          <Text style={styles.entryPreview} numberOfLines={2}>
            "{preview}"
          </Text>
        ) : null}
        <Text style={styles.entrySource}>{src.text}</Text>
      </View>
    </View>
  );
}

function groupByDay(entries: TimelineEntry[]): Row[] {
  const out: Row[] = [];
  let lastDay: string | null = null;
  for (const e of entries) {
    const day = dayHeading(e.occurredAt);
    if (day !== lastDay) {
      out.push({ type: 'heading', key: `h-${day}-${e.id}`, heading: day });
      lastDay = day;
    }
    out.push({ type: 'entry', key: e.id, entry: e });
  }
  return out;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    chipScroll: { flexGrow: 0, flexShrink: 0 },
    chipRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'] },
    dayHeading: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: spacing.md,
      marginBottom: spacing.xs,
    },
    entryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs },
    entryTime: { width: 56, fontSize: 12, color: colors.muted, paddingTop: 2 },
    entryText: { flex: 1, minWidth: 0, gap: 2 },
    entryTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
    entryLabel: { fontSize: 14, color: colors.fg, flexShrink: 1 },
    entryPreview: { fontSize: 13, color: colors.muted },
    entrySource: { fontSize: 11, color: colors.muted },
    durationBadge: { backgroundColor: colors.surface2, borderRadius: radius.pill, paddingHorizontal: spacing.xs, paddingVertical: 1 },
    durationBadgeText: { fontSize: 11, color: colors.muted },
  });
}
