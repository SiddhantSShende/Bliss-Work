import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CalendarX, Plus, Search, SearchX, X } from 'lucide-react-native';
import {
  Animated,
  BackHandler,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CallDTO } from '@taskboard/shared';
import { useJoinMeeting, useMeetings, useMeetingsInRange } from '../../hooks/useMeetings';
import { GlassBackdrop, GlassCard, MeetingGlass } from '../../components/meetings/MeetingsGlass';
import { MeetingCard } from '../../components/meetings/MeetingCard';
import { MeetingsCalendar } from '../../components/meetings/MeetingsCalendar';
import { spacing, type ThemeColors } from '../../constants/theme';
import {
  addDays,
  addMonths,
  dayKey,
  isPast,
  meetingEnd,
  meetingStart,
  monthGridStart,
  searchHaystack,
  sortByStart,
  startOfDay,
} from '../../lib/meetings';
import type { MeetingsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'MeetingsList'>;

/** Does `c` touch the local calendar day starting at `day`? A meeting that
 *  runs past midnight belongs to both days, matching the range endpoint. */
function occursOn(c: CallDTO, day: Date): boolean {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const start = meetingStart(c).getTime();
  const end = (meetingEnd(c) ?? meetingStart(c)).getTime();
  return start < dayEnd && Math.max(end, start) >= dayStart;
}

/**
 * Meetings tab. Calendar dots and the selected day's Upcoming/Past sections
 * come from the real `myCallsInRange` window for the month on screen;
 * "View all" (`MeetingsAll`) uses `myCalls()` / `myCallHistory()`; search
 * matches over everything those three have returned. Cards open
 * `MeetingDetail`; "+" opens the existing `ScheduleMeeting` flow.
 */
export function MeetingsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const join = useJoinMeeting();

  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<TextInput>(null);

  const gridStart = monthGridStart(selected);
  const range = useMeetingsInRange(gridStart, addDays(gridStart, 42));
  const { upcoming, history } = useMeetings();

  const openDetail = useCallback((c: CallDTO) => navigation.navigate('MeetingDetail', { callId: c.id }), [navigation]);

  // Days that get a dot. Cancelled meetings aren't happening, so they don't count.
  const meetingDays = useMemo(() => {
    const days = new Set<string>();
    for (const c of range.data ?? []) {
      if (c.status === 'CANCELLED') continue;
      const start = startOfDay(meetingStart(c));
      const end = startOfDay(meetingEnd(c) ?? meetingStart(c));
      for (let d = start; d.getTime() <= end.getTime() && days.size < 200; d = addDays(d, 1)) days.add(dayKey(d));
    }
    return days;
  }, [range.data]);

  const { dayUpcoming, dayPast } = useMemo(() => {
    const now = new Date();
    const onDay = (range.data ?? []).filter((c) => occursOn(c, selected));
    return {
      dayUpcoming: sortByStart(onDay.filter((c) => !isPast(c, now)), 'asc'),
      dayPast: sortByStart(onDay.filter((c) => isPast(c, now)), 'desc'),
    };
  }, [range.data, selected]);

  // Search runs over every real meeting fetched so far, de-duplicated.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const byId = new Map<string, CallDTO>();
    for (const c of [...(range.data ?? []), ...(upcoming.data ?? []), ...(history.data?.items ?? [])]) byId.set(c.id, c);
    return sortByStart([...byId.values()].filter((c) => searchHaystack(c).includes(q)), 'desc');
  }, [query, range.data, upcoming.data, history.data]);

  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    setSearching(false);
    setQuery('');
  }, []);

  // Android back closes the search instead of leaving the tab.
  useEffect(() => {
    if (!searching) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searching, closeSearch]);

  const changeMonth = (delta: -1 | 1) => setSelected((d) => addMonths(d, delta));
  const goToday = () => setSelected(startOfDay(new Date()));
  const refresh = () => {
    void range.refetch();
    void upcoming.refetch();
    void history.refetch();
  };

  const showError = range.isError && !range.data;
  const showSkeleton = range.isLoading;
  const noMeetings = !showError && !showSkeleton && dayUpcoming.length === 0 && dayPast.length === 0;

  return (
    <GlassBackdrop>
      <View style={[styles.flex, { paddingTop: insets.top }]}>
        {searching ? (
          <View style={styles.header}>
            <MeetingGlass borderRadius={22} style={styles.searchBox}>
              <View style={styles.searchInner}>
                <Search size={18} color={colors.muted} />
                <TextInput
                  ref={searchRef}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search meetings"
                  placeholderTextColor={colors.muted}
                  style={styles.searchInput}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {query ? (
                  <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
                    <X size={16} color={colors.muted} />
                  </Pressable>
                ) : null}
              </View>
            </MeetingGlass>
            <Pressable onPress={closeSearch} hitSlop={8} accessibilityRole="button">
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.header}>
            <Pressable onPress={goToday} hitSlop={10} style={styles.headerIcon} accessibilityLabel="Jump to today">
              <CalendarDays size={22} color={colors.fg} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Meetings
            </Text>
            <Pressable onPress={() => setSearching(true)} hitSlop={10} style={styles.headerIcon} accessibilityLabel="Search meetings">
              <Search size={22} color={colors.fg} />
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('ScheduleMeeting')}
              hitSlop={6}
              style={styles.addButton}
              accessibilityRole="button"
              accessibilityLabel="Schedule meeting"
            >
              <Plus size={20} color={colors.accentFg} />
            </Pressable>
          </View>
        )}

        {searching ? (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {!query.trim() ? (
              <Text style={styles.hint}>Search by title, participant or type.</Text>
            ) : results.length === 0 ? (
              <EmptyCard
                icon={SearchX}
                title="No meetings found"
                subtitle={`Nothing matches "${query.trim()}".`}
                colors={colors}
              />
            ) : (
              <View style={styles.cards}>
                {results.map((c) => (
                  <MeetingCard key={c.id} meeting={c} onPress={openDetail} onJoin={join} showDate />
                ))}
              </View>
            )}
          </ScrollView>
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={range.isRefetching}
                onRefresh={refresh}
                tintColor={colors.accent}
                colors={[colors.accent]}
              />
            }
          >
            <MeetingsCalendar
              selected={selected}
              onSelect={setSelected}
              onMonthChange={changeMonth}
              meetingDays={meetingDays}
              expanded={expanded}
              onToggleExpanded={() => setExpanded((v) => !v)}
            />

            {showSkeleton ? (
              <Skeleton colors={colors} />
            ) : showError ? (
              <GlassCard>
                <View style={styles.stateInner}>
                  <Text style={styles.stateTitle}>Unable to load meetings</Text>
                  <Pressable
                    onPress={() => void range.refetch()}
                    style={styles.retry}
                    accessibilityRole="button"
                    accessibilityLabel="Retry loading meetings"
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                </View>
              </GlassCard>
            ) : noMeetings ? (
              <EmptyCard icon={CalendarX} title="No meetings scheduled" subtitle="You're free for this day." colors={colors} />
            ) : (
              <>
                {dayUpcoming.length > 0 ? (
                  <Section title="Upcoming Meetings" onViewAll={() => navigation.navigate('MeetingsAll', { kind: 'upcoming' })} colors={colors}>
                    {dayUpcoming.map((c) => (
                      <MeetingCard key={c.id} meeting={c} onPress={openDetail} onJoin={join} />
                    ))}
                  </Section>
                ) : null}
                {dayPast.length > 0 ? (
                  <Section title="Past Meetings" onViewAll={() => navigation.navigate('MeetingsAll', { kind: 'past' })} colors={colors}>
                    {dayPast.map((c) => (
                      <MeetingCard key={c.id} meeting={c} onPress={openDetail} onJoin={join} />
                    ))}
                  </Section>
                ) : null}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </GlassBackdrop>
  );
}

function Section({
  title,
  onViewAll,
  colors,
  children,
}: {
  title: string;
  onViewAll: () => void;
  colors: ThemeColors;
  children: React.ReactNode;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Pressable onPress={onViewAll} hitSlop={10} accessibilityRole="button" accessibilityLabel={`View all ${title}`}>
          <Text style={styles.viewAll}>View all</Text>
        </Pressable>
      </View>
      <View style={styles.cards}>{children}</View>
    </View>
  );
}

function EmptyCard({
  icon: Icon,
  title,
  subtitle,
  colors,
}: {
  icon: typeof CalendarX;
  title: string;
  subtitle: string;
  colors: ThemeColors;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <GlassCard>
      <View style={styles.stateInner}>
        <View style={styles.emptyIcon}>
          <Icon size={26} color={colors.accent} />
        </View>
        <Text style={styles.stateTitle}>{title}</Text>
        <Text style={styles.stateSub}>{subtitle}</Text>
      </View>
    </GlassCard>
  );
}

/** Three placeholder glass cards, pulsing while meetings load. */
function Skeleton({ colors }: { colors: ThemeColors }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View style={styles.section} accessibilityLabel="Loading meetings">
      <Animated.View style={[styles.skelHeading, { opacity: pulse }]} />
      <View style={styles.cards}>
        {[0, 1, 2].map((i) => (
          <GlassCard key={i}>
            <Animated.View style={[styles.skelRow, { opacity: pulse }]}>
              <View style={styles.skelIcon} />
              <View style={styles.skelText}>
                <View style={[styles.skelBar, { width: '55%' }]} />
                <View style={[styles.skelBar, { width: '40%', height: 10 }]} />
                <View style={[styles.skelBar, { width: '30%', height: 10 }]} />
              </View>
            </Animated.View>
          </GlassCard>
        ))}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  const bone = colors.muted + '33';
  return StyleSheet.create({
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    headerIcon: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { flex: 1, fontSize: 24, fontWeight: '800', color: colors.fg },
    addButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchBox: { flex: 1 },
    searchInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, height: 42 },
    searchInput: { flex: 1, fontSize: 15, color: colors.fg, padding: 0 },
    cancel: { fontSize: 15, fontWeight: '600', color: colors.accent },
    // Tab bar is not absolutely positioned in this app, so normal bottom
    // padding is enough to keep the last card clear of it.
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.lg },
    hint: { textAlign: 'center', color: colors.muted, fontSize: 13, marginTop: spacing.xl },
    section: { gap: spacing.sm },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 },
    sectionTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.fg },
    viewAll: { fontSize: 13, fontWeight: '600', color: colors.accent },
    cards: { gap: spacing.sm },
    stateInner: { alignItems: 'center', gap: spacing.xs, padding: spacing.xl },
    emptyIcon: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    stateTitle: { fontSize: 15, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    stateSub: { fontSize: 13, color: colors.muted, textAlign: 'center' },
    retry: {
      marginTop: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingVertical: 10,
      borderRadius: 999,
      backgroundColor: colors.accent,
    },
    retryText: { color: colors.accentFg, fontWeight: '700', fontSize: 14 },
    skelHeading: { width: 150, height: 16, borderRadius: 8, backgroundColor: bone },
    skelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
    skelIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: bone },
    skelText: { flex: 1, gap: 6 },
    skelBar: { height: 13, borderRadius: 6, backgroundColor: bone },
  });
}
