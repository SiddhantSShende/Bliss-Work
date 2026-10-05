import { useCallback, useMemo } from 'react';
import { ArrowLeft, CalendarX } from 'lucide-react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CallDTO } from '@taskboard/shared';
import { useCallHistoryAll, useJoinMeeting, useMeetings } from '../../hooks/useMeetings';
import { GlassBackdrop, GlassCard } from '../../components/meetings/MeetingsGlass';
import { MeetingCard } from '../../components/meetings/MeetingCard';
import { spacing, type ThemeColors } from '../../constants/theme';
import { isPast, sortByStart } from '../../lib/meetings';
import type { MeetingsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'MeetingsAll'>;

/** "View all" target: every upcoming meeting (soonest first) or the full,
 *  cursor-paged history (newest first). Same real data as the main screen —
 *  `myCalls()` and `myCallHistory()` — just not limited to one day. */
export function MeetingsAllScreen({ route, navigation }: Props) {
  const { kind } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const join = useJoinMeeting();
  const { upcoming } = useMeetings();
  const history = useCallHistoryAll();
  const isUpcoming = kind === 'upcoming';

  const data = useMemo<CallDTO[]>(() => {
    if (isUpcoming) return sortByStart((upcoming.data ?? []).filter((c) => !isPast(c)), 'asc');
    return sortByStart(history.data?.pages.flatMap((p) => p.items) ?? [], 'desc');
  }, [isUpcoming, upcoming.data, history.data]);

  const query = isUpcoming ? upcoming : history;
  const openDetail = useCallback((c: CallDTO) => navigation.navigate('MeetingDetail', { callId: c.id }), [navigation]);
  const onEnd = () => {
    if (!isUpcoming && history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  };

  return (
    <GlassBackdrop>
      <View style={[styles.flex, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={styles.back} accessibilityLabel="Back">
            <ArrowLeft size={22} color={colors.fg} />
          </Pressable>
          <Text style={styles.headerTitle}>{isUpcoming ? 'Upcoming meetings' : 'Past meetings'}</Text>
        </View>

        {query.isError && data.length === 0 ? (
          <GlassCard style={styles.state}>
            <View style={styles.stateInner}>
              <Text style={styles.stateTitle}>Unable to load meetings</Text>
              <Pressable onPress={() => void query.refetch()} style={styles.retry} accessibilityRole="button">
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          </GlassCard>
        ) : (
          <FlatList
            data={data}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.list}
            refreshing={query.isRefetching && !history.isFetchingNextPage}
            onRefresh={() => void query.refetch()}
            ItemSeparatorComponent={Gap}
            ListEmptyComponent={
              query.isLoading ? (
                <ActivityIndicator color={colors.accent} style={styles.loader} />
              ) : (
                <GlassCard>
                  <View style={styles.stateInner}>
                    <CalendarX size={26} color={colors.accent} />
                    <Text style={styles.stateTitle}>{isUpcoming ? 'No upcoming meetings' : 'No past meetings'}</Text>
                    <Text style={styles.stateSub}>
                      {isUpcoming ? "You're all caught up." : 'Finished meetings appear here.'}
                    </Text>
                  </View>
                </GlassCard>
              )
            }
            ListFooterComponent={
              !isUpcoming ? (
                history.isFetchingNextPage ? (
                  <ActivityIndicator color={colors.accent} style={styles.loader} />
                ) : history.hasNextPage ? (
                  <Pressable onPress={() => void history.fetchNextPage()} style={styles.loadMoreButton} accessibilityRole="button">
                    <Text style={styles.loadMoreText}>Load More</Text>
                  </Pressable>
                ) : null
              ) : null
            }
            renderItem={({ item }) => <MeetingCard meeting={item} onPress={openDetail} onJoin={join} showDate />}
          />
        )}
      </View>
    </GlassBackdrop>
  );
}

function Gap() {
  return <View style={{ height: spacing.sm }} />;
}

function createStyles(colors: ThemeColors) {
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
    back: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
    headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.fg },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
    loader: { marginTop: spacing.xl },
    state: { marginHorizontal: spacing.lg },
    stateInner: { alignItems: 'center', gap: spacing.xs, padding: spacing.xl },
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
    loadMoreButton: {
      marginTop: spacing.xl,
      alignSelf: 'center',
      paddingHorizontal: spacing.xl,
      paddingVertical: 12,
      borderRadius: 999,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    loadMoreText: { color: colors.fg, fontWeight: '600', fontSize: 14 },
  });
}
