import { useMemo, useState } from 'react';
import { Plus, Video } from 'lucide-react-native';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CallDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useMeetings } from '../../hooks/useMeetings';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import type { MeetingsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'MeetingsList'>;

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'No time set';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 14 real calendar days starting today — a plain Date-math strip, no
 *  date-picker library needed for a fixed-width selector like this. */
function dateStrip(): Date[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d;
  });
}

/**
 * Meetings tab: a day strip (client-side filter over the real upcoming-call
 * list — there's no server-side date-range query on mobile, so this filters
 * what's already fetched, same data `myCalls()` always returned) plus
 * Upcoming/Past lists over real call data. "Join" opens the call's real web
 * room (`/call/:callId`, the same route CallWindow.tsx serves on web) in the
 * device browser — mobile has no WebRTC transport of its own (`rtcAvailable`
 * is false there; see runtime.tsx).
 */
export function MeetingsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { config } = useRuntime();
  const { upcoming, history } = useMeetings();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const strip = useMemo(dateStrip, []);
  const [selectedDate, setSelectedDate] = useState<Date>(strip[0]!);

  const upcomingForDay = useMemo(
    () => (upcoming.data ?? []).filter((c) => c.scheduledAt && sameDay(new Date(c.scheduledAt), selectedDate)),
    [upcoming.data, selectedDate],
  );

  const data = tab === 'upcoming' ? upcomingForDay : history.data?.items ?? [];
  const refreshing = tab === 'upcoming' ? upcoming.isRefetching : history.isRefetching;
  const onRefresh = () => void (tab === 'upcoming' ? upcoming.refetch() : history.refetch());

  const join = (call: CallDTO) => void Linking.openURL(`${config.webBaseUrl}/call/${call.id}`);
  const isToday = sameDay(selectedDate, strip[0]!);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Meetings</Text>
        <Pressable onPress={() => navigation.navigate('ScheduleMeeting')} style={styles.addButton} hitSlop={8}>
          <Plus size={20} color={colors.accentFg} />
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {(['upcoming', 'past'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'upcoming' ? 'Upcoming' : 'Past'}
            </Text>
            {tab === t ? <View style={styles.tabUnderline} /> : null}
          </Pressable>
        ))}
      </View>

      {tab === 'upcoming' ? (
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={strip}
          keyExtractor={(d) => d.toISOString()}
          contentContainerStyle={styles.strip}
          renderItem={({ item }) => {
            const active = sameDay(item, selectedDate);
            return (
              <Pressable onPress={() => setSelectedDate(item)} style={[styles.dayCell, active && styles.dayCellActive]}>
                <Text style={[styles.dayName, active && styles.dayTextActive]}>
                  {item.toLocaleDateString(undefined, { weekday: 'short' })}
                </Text>
                <Text style={[styles.dayNumber, active && styles.dayTextActive]}>{item.getDate()}</Text>
              </Pressable>
            );
          }}
        />
      ) : null}

      <FlatList
        data={data}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListEmptyComponent={
          <EmptyState
            icon={Video}
            title={tab === 'upcoming' ? (isToday ? 'No meetings today' : 'No meetings this day') : 'No meetings'}
            subtitle={tab === 'upcoming' ? 'Enjoy your day!' : 'Past meetings appear here.'}
          />
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <View style={styles.cardIcon}>
              <Video size={18} color={colors.accent} />
            </View>
            <View style={styles.cardText}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title || 'Meeting'}
              </Text>
              <Text style={styles.when}>{formatWhen(item.scheduledAt ?? item.startedAt)}</Text>
            </View>
            {tab === 'upcoming' ? (
              <Button title="Join" onPress={() => join(item)} style={styles.joinButton} />
            ) : null}
          </Card>
        )}
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
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    headerTitle: { fontSize: 22, fontWeight: '700', color: colors.fg },
    addButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tabs: {
      flexDirection: 'row',
      paddingHorizontal: spacing.lg,
      gap: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    tab: { paddingBottom: spacing.sm },
    tabText: { fontSize: 14, fontWeight: '600', color: colors.muted },
    tabTextActive: { color: colors.accent },
    tabUnderline: { height: 2, backgroundColor: colors.accent, borderRadius: radius.pill, marginTop: spacing.xs },
    strip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
    dayCell: {
      width: 48,
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radius.card,
      backgroundColor: colors.surface2,
    },
    dayCellActive: { backgroundColor: colors.accent },
    dayName: { fontSize: 11, fontWeight: '600', color: colors.muted },
    dayNumber: { fontSize: 15, fontWeight: '700', color: colors.fg, marginTop: 2 },
    dayTextActive: { color: colors.accentFg },
    list: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    cardIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardText: { flex: 1, gap: 2 },
    title: { fontSize: 15, fontWeight: '600', color: colors.fg },
    when: { fontSize: 12, color: colors.muted },
    joinButton: { paddingHorizontal: spacing.md, paddingVertical: 8 },
  });
}
