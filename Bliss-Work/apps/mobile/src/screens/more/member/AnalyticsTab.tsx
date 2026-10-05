import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react-native';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { ACTIVITY_RANGES, computeRange, parseLocalDay, type RangeKey } from '@taskboard/app/lib/dateRange';
import { formatDuration, surfaceLabel } from '@taskboard/app/features/member/activityLabels';
import type { NamedCount } from '@taskboard/shared';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState, LoadingState } from '../../../components/QueryState';
import { qk } from '../../../hooks/queryKeys';
import { radius, spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';
import { isForbidden } from './memberUi';

const RANGES = ACTIVITY_RANGES.filter((r) => r.key !== 'custom');

/**
 * `GET /telemetry/members/{id}/summary` — rollups computed server-side by
 * telemetry-svc. What it does NOT provide is any per-feature count (tasks
 * created, meetings joined, files uploaded); the only breakdowns are by app
 * section (`bySurface`) and by recorded action (`byAction`). Those are shown
 * as-is; nothing here is derived from partial local data.
 */
export function AnalyticsTab({ subject }: { subject: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const [range, setRange] = useState<RangeKey>('30d');
  const { from, to } = useMemo(() => computeRange(range), [range]);

  const q = useQuery({
    queryKey: qk.activitySummary(subject, from, to),
    queryFn: () => api.activitySummary(subject, { from, to }),
  });

  const data = q.data;
  const days = useMemo(() => data?.days ?? [], [data]);
  const maxActive = useMemo(() => Math.max(1, ...days.map((d) => d.activeMs)), [days]);
  const activeDays = days.filter((d) => d.activeMs > 0).length;
  const peak = useMemo(
    () => days.reduce<(typeof days)[number] | undefined>((best, d) => (d.activeMs > (best?.activeMs ?? 0) ? d : best), undefined),
    [days],
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow}>
        {RANGES.map((r) => (
          <Chip key={r.key} label={r.label} active={range === r.key} onPress={() => setRange(r.key)} />
        ))}
      </ScrollView>

      {q.isLoading ? (
        <LoadingState label="Loading analytics..." />
      ) : q.isError ? (
        isForbidden(q.error) ? (
          <EmptyState icon={BarChart3} title="Analytics unavailable" subtitle="You don't have permission to view this member's analytics." />
        ) : (
          <ErrorState title="Analytics unavailable" error={q.error} onRetry={() => void q.refetch()} />
        )
      ) : !data || days.length === 0 ? (
        <EmptyState icon={BarChart3} title="No activity in this period" subtitle="Analytics appear once there is a day of activity to summarise." />
      ) : (
        <>
          <View style={styles.kpiGrid}>
            <Kpi colors={colors} label="Active time" value={formatDuration(data.totalActiveMs) ?? '0m'} hint={`across ${activeDays} day${activeDays === 1 ? '' : 's'}`} />
            <Kpi colors={colors} label="Sessions" value={String(data.sessions)} hint="recorded sign-ins" />
            <Kpi
              colors={colors}
              label="Avg. session"
              value={data.sessions > 0 ? (formatDuration(data.totalActiveMs / data.sessions) ?? '0m') : '—'}
              hint="active time per session"
            />
            <Kpi colors={colors} label="Actions" value={String(data.events)} hint="recorded events" />
          </View>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Active time per day</Text>
            <View style={styles.bars} accessibilityLabel="Active time per day">
              {days.map((d) => (
                <View key={d.day} style={styles.barSlot}>
                  <View style={[styles.bar, { height: `${Math.max(2, (d.activeMs / maxActive) * 100)}%` }]} />
                </View>
              ))}
            </View>
            <View style={styles.barAxis}>
              <Text style={styles.hint}>{parseLocalDay(days[0]!.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Text>
              <Text style={styles.hint}>{parseLocalDay(days[days.length - 1]!.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Text>
            </View>
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Highlights</Text>
            <HighlightRow
              colors={colors}
              label="Best day"
              value={
                peak && peak.activeMs > 0
                  ? `${parseLocalDay(peak.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${formatDuration(peak.activeMs) ?? ''}`
                  : '—'
              }
            />
            <HighlightRow colors={colors} label="Idle, signed in" value={formatDuration(data.totalIdleMs) ?? '—'} last />
          </Card>

          {data.bySurface.length > 0 ? (
            <RankedCard
              colors={colors}
              title="Where they spend time"
              rows={data.bySurface.map((s) => ({ key: s.key, label: surfaceLabel(s.key) ?? s.key, value: s.valueMs, text: formatDuration(s.valueMs) ?? '<1s' }))}
            />
          ) : null}
          {data.byAction.length > 0 ? (
            <RankedCard
              colors={colors}
              title="What they do"
              rows={data.byAction.map((a: NamedCount) => ({ key: a.key, label: a.label || a.key, value: a.count, text: String(a.count) }))}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function Kpi({ colors, label, value, hint }: { colors: ThemeColors; label: string; value: string; hint: string }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Card style={styles.kpi}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.kpiValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.hint}>{hint}</Text>
    </Card>
  );
}

function HighlightRow({ colors, label, value, last }: { colors: ThemeColors; label: string; value: string; last?: boolean }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.hlRow, !last && styles.hlDivider]}>
      <Text style={styles.hlLabel}>{label}</Text>
      <Text style={styles.hlValue}>{value}</Text>
    </View>
  );
}

function RankedCard({ colors, title, rows }: { colors: ThemeColors; title: string; rows: { key: string; label: string; value: number; text: string }[] }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {rows.slice(0, 8).map((r) => (
        <View key={r.key} style={styles.rankRow}>
          <View style={styles.rankTop}>
            <Text style={styles.rankLabel} numberOfLines={1}>
              {r.label}
            </Text>
            <Text style={styles.hint}>{r.text}</Text>
          </View>
          <View style={styles.rankTrack}>
            <View style={[styles.rankFill, { width: `${Math.max(2, (r.value / max) * 100)}%` }]} />
          </View>
        </View>
      ))}
    </Card>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    content: { paddingBottom: spacing['2xl'], gap: spacing.md },
    chipScroll: { flexGrow: 0 },
    chipRow: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
    kpi: { flexGrow: 1, flexBasis: '45%', gap: 2 },
    kpiValue: { fontSize: 22, fontWeight: '700', color: colors.fg },
    card: { marginHorizontal: spacing.lg, gap: spacing.sm },
    cardTitle: { fontSize: 14, fontWeight: '700', color: colors.fg },
    hint: { fontSize: 12, color: colors.muted },
    bars: { flexDirection: 'row', alignItems: 'flex-end', height: 88, gap: 1 },
    barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
    bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 2 },
    barAxis: { flexDirection: 'row', justifyContent: 'space-between' },
    hlRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.sm },
    hlDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    hlLabel: { fontSize: 14, color: colors.muted },
    hlValue: { fontSize: 14, fontWeight: '600', color: colors.fg, flexShrink: 1, textAlign: 'right' },
    rankRow: { gap: 4 },
    rankTop: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    rankLabel: { fontSize: 13, color: colors.fg, flexShrink: 1 },
    rankTrack: { height: 6, borderRadius: radius.pill, backgroundColor: colors.surface2, overflow: 'hidden' },
    rankFill: { height: '100%', backgroundColor: colors.accent, borderRadius: radius.pill },
  });
}
