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

/**
 * Meetings tab: upcoming/past lists over real call data. "Join" opens the
 * call's real web room (`/call/:callId`, the same route CallWindow.tsx
 * serves on web) in the device browser — mobile has no WebRTC transport of
 * its own (`rtcAvailable` is false there; see runtime.tsx), and building one
 * is out of scope for a presentation-layer redesign, so this keeps meetings
 * fully joinable without faking an in-app call screen.
 */
export function MeetingsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { config } = useRuntime();
  const { upcoming, history } = useMeetings();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  const data = tab === 'upcoming' ? upcoming.data ?? [] : history.data?.items ?? [];
  const refreshing = tab === 'upcoming' ? upcoming.isRefetching : history.isRefetching;
  const onRefresh = () => void (tab === 'upcoming' ? upcoming.refetch() : history.refetch());

  const join = (call: CallDTO) => void Linking.openURL(`${config.webBaseUrl}/call/${call.id}`);

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

      <FlatList
        data={data}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListEmptyComponent={
          <EmptyState icon={Video} title="No meetings" subtitle="Scheduled and past meetings appear here." />
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
    list: { padding: spacing.lg, gap: spacing.sm },
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
