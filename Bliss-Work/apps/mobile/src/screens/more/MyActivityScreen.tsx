import { useMemo, useState } from 'react';
import { ArrowLeft, Activity, ShieldCheck } from 'lucide-react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import type { TimelineEntry } from '@taskboard/shared';
import { actionLabel, dayHeading, formatDuration, sourceLabel } from '@taskboard/app/features/member/activityLabels';
import { EmptyState } from '../../components/EmptyState';
import { qk } from '../../hooks/queryKeys';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'MyActivity'>;
type Filter = 'all' | 'engagement' | 'navigation' | 'auth' | 'security';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'engagement', label: 'Work' },
  { key: 'navigation', label: 'In-app' },
  { key: 'auth', label: 'Sign-ins' },
  { key: 'security', label: 'Security' },
];

interface Row {
  type: 'heading' | 'entry';
  key: string;
  heading?: string;
  entry?: TimelineEntry;
}

/**
 * Mirrors packages/app/src/routes/MyActivity.tsx + MemberTimeline.tsx (web):
 * the member's own activity record, `userId: "me"` so the server resolves
 * the subject — same endpoint the admin view reads, same formatting helpers
 * (`actionLabel`/`dayHeading`/`sourceLabel`/`formatDuration`, imported
 * straight from @taskboard/app rather than re-implemented). Rendered as a
 * flat, grouped list instead of web's charted timeline — there's no chart on
 * this page to begin with, just a day-grouped feed.
 */
export function MyActivityScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const [filter, setFilter] = useState<Filter>('all');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: qk.activityTimeline('me', filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.activityTimeline('me', { cursor: pageParam, limit: 50, category: filter === 'all' ? undefined : filter }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = data?.pages.flatMap((p) => p.entries) ?? [];
  const rows = useMemo(() => groupByDay(entries), [entries]);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Your activity</Text>
        <View style={{ width: 22 }} />
      </View>
      <Text style={styles.subtitle}>Everything BlissWork records about how you work. Showing the last 7 days.</Text>

      <View style={styles.tabs}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={FILTERS}
          keyExtractor={(f) => f.key}
          contentContainerStyle={{ gap: spacing.lg, paddingHorizontal: spacing.lg }}
          renderItem={({ item }) => (
            <Pressable onPress={() => setFilter(item.key)} style={styles.tab}>
              <Text style={[styles.tabText, filter === item.key && styles.tabTextActive]}>{item.label}</Text>
              {filter === item.key ? <View style={styles.tabUnderline} /> : null}
            </Pressable>
          )}
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !isLoading ? <EmptyState icon={Activity} title="No activity recorded yet" subtitle="Activity appears here as you use BlissWork." /> : null
        }
        onEndReached={() => hasNextPage && fetchNextPage()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={isFetchingNextPage ? <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.md }} /> : null}
        renderItem={({ item }) =>
          item.type === 'heading' ? (
            <Text style={styles.dayHeading}>{item.heading}</Text>
          ) : (
            <EntryRow colors={colors} entry={item.entry!} />
          )
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
      <Text style={styles.entryTime}>
        {new Date(entry.occurredAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </Text>
      <View style={styles.entryText}>
        <View style={styles.entryTop}>
          <Text style={styles.entryLabel}>{actionLabel(entry)}</Text>
          {duration ? (
            <View style={styles.durationBadge}>
              <Text style={styles.durationBadgeText}>{duration}</Text>
            </View>
          ) : null}
          {src.verified ? <ShieldCheck size={13} color={colors.success} /> : null}
        </View>
        {preview ? (
          <Text style={styles.entryPreview} numberOfLines={1}>
            "{preview}"
          </Text>
        ) : null}
      </View>
      <Text style={styles.entrySource}>{src.text}</Text>
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
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    subtitle: { fontSize: 12, color: colors.muted, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    tabs: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.sm },
    tab: { paddingBottom: 4 },
    tabText: { fontSize: 13, fontWeight: '600', color: colors.muted },
    tabTextActive: { color: colors.accent },
    tabUnderline: { height: 2, backgroundColor: colors.accent, borderRadius: radius.pill, marginTop: 4 },
    list: { padding: spacing.lg, paddingBottom: spacing['2xl'] },
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
    entryText: { flex: 1, gap: 2 },
    entryTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
    entryLabel: { fontSize: 14, color: colors.fg },
    entryPreview: { fontSize: 13, color: colors.muted },
    durationBadge: { backgroundColor: colors.surface2, borderRadius: radius.pill, paddingHorizontal: spacing.xs, paddingVertical: 1 },
    durationBadgeText: { fontSize: 11, color: colors.muted },
    entrySource: { fontSize: 11, color: colors.muted, paddingTop: 2 },
  });
}
