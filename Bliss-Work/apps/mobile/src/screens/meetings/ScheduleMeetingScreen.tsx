import { useMemo, useState } from 'react';
import { ArrowLeft, Mic, Video } from 'lucide-react-native';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useScheduleMeeting } from '../../hooks/useMeetings';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import type { MeetingsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'ScheduleMeeting'>;

/** Quick-pick start times rather than a full date/time picker — no
 *  date-picker library is installed in this app and adding one is outside
 *  this redesign's scope; these cover the common cases with zero new
 *  dependencies while still producing a real ISO `scheduledAt`. */
const START_OPTIONS = [
  { label: 'Now', minutesFromNow: 0 },
  { label: 'In 15 min', minutesFromNow: 15 },
  { label: 'In 1 hour', minutesFromNow: 60 },
  { label: 'Tomorrow, 9 AM', minutesFromNow: null },
];

function tomorrowNineAm(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export function ScheduleMeetingScreen({ route, navigation }: Props) {
  const { inviteeId, inviteeName } = route.params ?? {};
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const schedule = useScheduleMeeting();
  const [title, setTitle] = useState('');
  const [media, setMedia] = useState<'audio' | 'video'>('video');
  const [startIndex, setStartIndex] = useState(1);

  const submit = async () => {
    const opt = START_OPTIONS[startIndex]!;
    const scheduledAt = opt.minutesFromNow === null ? tomorrowNineAm() : new Date(Date.now() + opt.minutesFromNow * 60_000).toISOString();
    await schedule.mutateAsync({
      title: title.trim() || undefined,
      media,
      scheduledAt,
      durationMinutes: 60,
      inviteeIds: inviteeId ? [inviteeId] : undefined,
    });
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Schedule meeting</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {inviteeName ? <Text style={styles.inviteeNote}>With {inviteeName}</Text> : null}
        <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Team sync" />

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Type</Text>
          <View style={styles.mediaRow}>
            <Pressable onPress={() => setMedia('video')} style={[styles.mediaOption, media === 'video' && styles.mediaOptionActive]}>
              <Video size={16} color={media === 'video' ? colors.accentFg : colors.fg} />
              <Text style={[styles.mediaText, media === 'video' && styles.mediaTextActive]}>Video</Text>
            </Pressable>
            <Pressable onPress={() => setMedia('audio')} style={[styles.mediaOption, media === 'audio' && styles.mediaOptionActive]}>
              <Mic size={16} color={media === 'audio' ? colors.accentFg : colors.fg} />
              <Text style={[styles.mediaText, media === 'audio' && styles.mediaTextActive]}>Audio</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Starts</Text>
          <View style={styles.startGrid}>
            {START_OPTIONS.map((opt, i) => (
              <Pressable
                key={opt.label}
                onPress={() => setStartIndex(i)}
                style={[styles.startOption, startIndex === i && styles.startOptionActive]}
              >
                <Text style={[styles.startText, startIndex === i && styles.startTextActive]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Button title="Schedule" onPress={() => void submit()} loading={schedule.isPending} />
      </ScrollView>
    </KeyboardAvoidingView>
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
    content: { padding: spacing.lg, gap: spacing.lg },
    inviteeNote: { fontSize: 13, fontWeight: '600', color: colors.accent, marginBottom: -spacing.sm },
    field: { gap: spacing.xs },
    fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.muted },
    mediaRow: { flexDirection: 'row', gap: spacing.sm },
    mediaOption: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: 12,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    mediaOptionActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    mediaText: { fontSize: 14, fontWeight: '600', color: colors.fg },
    mediaTextActive: { color: colors.accentFg },
    startGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    startOption: {
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
    },
    startOptionActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
    startText: { fontSize: 13, fontWeight: '600', color: colors.fg },
    startTextActive: { color: colors.accent },
  });
}
