import { useContext, useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarPlus, Mic, Plus, Users, Video, X } from 'lucide-react-native';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import * as Notifications from 'expo-notifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useScheduleMeeting } from '../../hooks/useMeetings';
import type { CallDTO, ChannelDTO, UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { errorText } from '@taskboard/app/lib/errorText';
import { useSession } from '@taskboard/app/store/session';
import { Button } from '../../components/Button';
import { ChatKeyboardAvoider } from '../../components/ChatKeyboardAvoider';
import { GlassSurface } from '../../components/glass/GlassSurface';
import { ChannelPickerSheet } from '../../components/meetings/ChannelPickerSheet';
import { DateTimeRow } from '../../components/meetings/DateTimeRow';
import { useCalls } from '../../calls/CallProvider';
import { planReminders } from '../../calls/meetingReminders';
import {
  DEFAULT_MEETING_MINUTES,
  MAX_MEETING_INVITEES,
  classifyStart,
  describeWhen,
  durationMinutes,
  floorToMinute,
  formatDateLong,
  inviteesSummary,
  mergeInviteeIds,
  validateMeeting,
} from '../../lib/meetingSchedule';
import { formatClock } from '../../lib/meetings';
import { MemberPickerSheet } from '../../components/MemberPickerSheet';
import { TextField } from '../../components/TextField';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import type { MeetingsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'ScheduleMeeting'>;

/** How often the Start Now / Schedule label re-evaluates while the form sits open. */
const CLOCK_TICK_MS = 15_000;

export function ScheduleMeetingScreen({ route, navigation }: Props) {
  const { inviteeId, inviteeName } = route.params ?? {};
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const schedule = useScheduleMeeting();
  const { joinMeeting } = useCalls();
  const [title, setTitle] = useState('');
  const [media, setMedia] = useState<'audio' | 'video'>('video');
  // Extra invitees chosen here (the chat-header "Schedule Call" preset, if any, is kept separately).
  const [invitees, setInvitees] = useState<UserDTO[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Channels chosen here: everyone in each is invited, resolved from the real roster at submit.
  const [channels, setChannels] = useState<ChannelDTO[]>([]);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const { api } = useRuntime();
  const selfId = useSession((s) => s.user?.id);
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  // The backend caps an up-front roster (maxMeetingInvitees = 200).
  const inviteeIds = useMemo(() => Array.from(new Set([...(inviteeId ? [inviteeId] : []), ...invitees.map((u) => u.id)])), [inviteeId, invitees]);

  // Until the user touches a time it FOLLOWS the clock (start = now, end = start
  // + the default hour), so a form left open for a few minutes still says
  // "Start Now" instead of turning into "start time has passed". Once they pick
  // a value it is theirs and is never changed behind their back.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);
  const [pickedStart, setPickedStart] = useState<Date | null>(null);
  const [pickedEnd, setPickedEnd] = useState<Date | null>(null);
  const [attempted, setAttempted] = useState(false);
  const startAt = pickedStart ?? floorToMinute(now);
  const endAt = pickedEnd ?? new Date(startAt.getTime() + DEFAULT_MEETING_MINUTES * 60_000);

  // Decided from real instants on every render, so the button follows the date
  // and time as they change — no reopening the form.
  const kind = classifyStart(startAt, now);
  const isFuture = kind === 'future';
  const errors = validateMeeting({ title, startAt, endAt, now });
  const invalid = Object.keys(errors).length > 0;

  /** Everyone in the chosen channels, from each channel's real roster (blocked users
   *  and the organiser themself excluded). Null = it failed, and the user was told. */
  const resolveChannelMemberIds = async (): Promise<string[] | null> => {
    if (channels.length === 0) return [];
    setResolving(true);
    try {
      const rosters = await Promise.all(channels.map((c) => api.channelRoster(c.id)));
      return rosters.flat().filter((m) => !m.blocked && m.userId !== selfId).map((m) => m.userId);
    } catch (e) {
      Alert.alert("Couldn't load channel members", errorText(e));
      return null;
    } finally {
      setResolving(false);
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (invalid) return;
    const fromChannels = await resolveChannelMemberIds();
    if (fromChannels === null) return;
    const everyone = mergeInviteeIds(inviteeIds, fromChannels);
    if (everyone.length > MAX_MEETING_INVITEES) {
      Alert.alert('Too many people', `A meeting can invite up to ${MAX_MEETING_INVITEES} people up front; these channels and members add up to ${everyone.length}. Remove a channel or some members.`);
      return;
    }
    const roster = everyone.length ? everyone : undefined;
    // Re-read the clock: "now" may be a few seconds stale.
    const decided = classifyStart(startAt, Date.now());
    try {
      if (decided === 'future') {
        const call = await schedule.mutateAsync({
          title: title.trim(),
          media,
          scheduledAt: startAt.toISOString(), // an absolute instant; the server stores UTC, every device shows its own local time
          durationMinutes: durationMinutes(startAt, endAt),
          inviteeIds: roster,
        });
        navigation.goBack();
        void confirmScheduled(call, startAt, endAt);
      } else {
        // Start Now: no scheduledAt, exactly as web sends it — the server opens a live meeting.
        const call = await schedule.mutateAsync({
          title: title.trim(),
          media,
          inviteeIds: roster,
        });
        navigation.goBack();
        joinMeeting(call.id, call.media, call.title || undefined);
      }
    } catch {
      // useScheduleMeeting's onError already showed the server's reason; stay on the form so nothing is lost.
    }
  };

  // ── live preview ──
  const peopleNames = [...(inviteeId ? [inviteeName ?? 'Invited'] : []), ...invitees.map((u) => u.displayName)];
  const channelNames = channels.map((c) => c.name);
  const previewTitle = title.trim() || 'Untitled meeting';
  const busy = schedule.isPending || resolving;


  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.sm, paddingBottom: tabBarHeight > 0 ? spacing.sm : insets.bottom + spacing.sm }]}>
      <ChatKeyboardAvoider style={styles.cardWrap} iosKeyboardVerticalOffset={insets.top}>
        <GlassSurface borderRadius={24} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} accessibilityRole="header">
            New Meeting
          </Text>
          <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <X size={22} color={colors.muted} />
          </Pressable>
        </View>

        <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.field}>
            <Text style={styles.sectionLabel}>Meeting Title</Text>
            <TextField value={title} onChangeText={setTitle} placeholder="Enter meeting title" maxLength={200} />
            {attempted && errors.title ? <Text style={styles.error}>{errors.title}</Text> : null}
          </View>

          <DateTimeRow label="Start Time" value={startAt} onChange={setPickedStart} error={errors.start} minDate={new Date(now)} />
          <DateTimeRow label="End Time" value={endAt} onChange={setPickedEnd} error={errors.end} minDate={startAt} />

          <View style={styles.field}>
            <Text style={styles.sectionLabel}>Members</Text>
            {peopleNames.length === 0 ? <Text style={styles.hint}>No members added yet.</Text> : null}
            {inviteeId || invitees.length ? (
              <View style={styles.chips}>
                {inviteeId ? (
                  <View style={styles.chip}>
                    <Text style={styles.chipText} numberOfLines={1}>
                      {inviteeName ?? 'Invited'}
                    </Text>
                  </View>
                ) : null}
                {invitees.map((u) => (
                  <Pressable key={u.id} onPress={() => setInvitees((prev) => prev.filter((p) => p.id !== u.id))} style={styles.chip} accessibilityLabel={`Remove ${u.displayName}`}>
                    <Text style={styles.chipText} numberOfLines={1}>
                      {u.displayName}
                    </Text>
                    <X size={13} color={colors.accent} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable onPress={() => setPickerOpen(true)} style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Add members">
              <Plus size={16} color={colors.fg} />
              <Text style={styles.addBtnText}>Add members</Text>
            </Pressable>
          </View>

          <View style={styles.field}>
            <Text style={styles.sectionLabel}>Channels</Text>
            {channels.length === 0 ? <Text style={styles.hint}>No channels added yet.</Text> : null}
            <Text style={styles.hint}>Everyone in a channel is invited.</Text>
            {channels.length ? (
              <View style={styles.chips}>
                {channels.map((c) => (
                  <Pressable key={c.id} onPress={() => setChannels((prev) => prev.filter((p) => p.id !== c.id))} style={styles.chip} accessibilityLabel={`Remove ${c.name}`}>
                    <Text style={styles.chipText} numberOfLines={1}>
                      #{c.name}
                    </Text>
                    <X size={13} color={colors.accent} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable onPress={() => setChannelPickerOpen(true)} style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Add channels">
              <Plus size={16} color={colors.fg} />
              <Text style={styles.addBtnText}>Add channels</Text>
            </Pressable>
          </View>

          <View style={styles.field}>
            <Text style={styles.sectionLabel}>Type</Text>
            <View style={styles.mediaRow}>
              <Pressable onPress={() => setMedia('video')} style={[styles.mediaOption, media === 'video' && styles.mediaOptionActive]} accessibilityRole="button" accessibilityState={{ selected: media === 'video' }}>
                <Video size={16} color={media === 'video' ? colors.accentFg : colors.fg} />
                <Text style={[styles.mediaText, media === 'video' && styles.mediaTextActive]}>Video</Text>
              </Pressable>
              <Pressable onPress={() => setMedia('audio')} style={[styles.mediaOption, media === 'audio' && styles.mediaOptionActive]} accessibilityRole="button" accessibilityState={{ selected: media === 'audio' }}>
                <Mic size={16} color={media === 'audio' ? colors.accentFg : colors.fg} />
                <Text style={[styles.mediaText, media === 'audio' && styles.mediaTextActive]}>Audio</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.preview} accessibilityLabel="Meeting preview">
            <Text style={styles.previewLabel}>MEETING PREVIEW</Text>
            <Text style={styles.previewTitle} numberOfLines={2}>
              {previewTitle}
            </Text>
            <View style={styles.previewRow}>
              <CalendarDays size={16} color={colors.accent} />
              <Text style={styles.previewText}>{describeWhen(startAt, endAt, now, formatClock)}</Text>
            </View>
            <View style={styles.previewRow}>
              <Users size={16} color={colors.accent} />
              <Text style={styles.previewText}>{inviteesSummary(peopleNames, channelNames)}</Text>
            </View>
            <View style={styles.previewRow}>
              {media === 'video' ? <Video size={16} color={colors.accent} /> : <Mic size={16} color={colors.accent} />}
              <Text style={styles.previewText}>{media === 'video' ? 'Online meeting' : 'Audio meeting'}</Text>
            </View>
          </View>
        </ScrollView>

        {/* Outside the ScrollView: the actions stay reachable however long the form gets. */}
        <View style={styles.footer}>
          <Pressable onPress={() => navigation.goBack()} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Button
            title={isFuture ? 'Schedule Meeting' : 'Start Now'}
            icon={isFuture ? CalendarPlus : Video}
            onPress={() => void submit()}
            loading={busy}
            disabled={invalid && (errors.start !== undefined || errors.end !== undefined)}
            style={styles.primary}
          />
        </View>
        </GlassSurface>
      </ChatKeyboardAvoider>

      <MemberPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Invite members"
        alreadyIds={[...(inviteeId ? [inviteeId] : []), ...invitees.map((u) => u.id)]}
        alreadyLabel="Already invited"
        confirmLabel={(n) => (n > 1 ? `Invite ${n} members` : 'Invite member')}
        onConfirm={(users) => setInvitees((prev) => [...prev, ...users.filter((u) => !prev.some((p) => p.id === u.id))])}
      />
      <ChannelPickerSheet
        visible={channelPickerOpen}
        onClose={() => setChannelPickerOpen(false)}
        alreadyIds={channels.map((c) => c.id)}
        onConfirm={(picked) => setChannels((prev) => [...prev, ...picked.filter((c) => !prev.some((p) => p.id === c.id))])}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.md },
    cardWrap: { flex: 1 },
    card: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.md,
    },
    headerTitle: { fontSize: 20, fontWeight: '700', color: colors.fg },
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.lg },
    field: { gap: spacing.sm },
    sectionLabel: { fontSize: 14, fontWeight: '600', color: colors.fg },
    hint: { fontSize: 13, color: colors.muted },
    error: { fontSize: 12, color: colors.danger },
    pressed: { opacity: 0.7 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: '100%', paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    chipText: { fontSize: 13, color: colors.fg, flexShrink: 1 },
    addBtn: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      minHeight: 44,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    addBtnText: { fontSize: 14, fontWeight: '600', color: colors.fg },
    mediaRow: { flexDirection: 'row', gap: spacing.sm },
    mediaOption: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: 44,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    mediaOptionActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    mediaText: { fontSize: 14, fontWeight: '600', color: colors.fg },
    mediaTextActive: { color: colors.accentFg },
    preview: { gap: spacing.sm, padding: spacing.lg, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 },
    previewLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, color: colors.muted },
    previewTitle: { fontSize: 17, fontWeight: '700', color: colors.fg },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    previewText: { flex: 1, fontSize: 14, color: colors.fg },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    cancel: { paddingHorizontal: spacing.lg, minHeight: 48, justifyContent: 'center', borderRadius: radius.card, borderWidth: 1, borderColor: colors.border },
    cancelText: { fontSize: 15, fontWeight: '600', color: colors.fg },
    primary: { flex: 1, maxWidth: 240 },
  });
}

/** "Meeting scheduled" summary. The reminder line reflects what will really
 *  happen: on only when notifications are allowed and the 10-minute mark is still ahead. */
async function confirmScheduled(call: CallDTO, startAt: Date, endAt: Date): Promise<void> {
  const perm = await Notifications.getPermissionsAsync().catch(() => null);
  const reminderScheduled = planReminders([call], Date.now()).length > 0;
  const reminder = !perm?.granted
    ? 'Reminder: off — allow notifications for BlissWork in Settings to get one 10 minutes before.'
    : reminderScheduled
      ? 'Reminder: 10 minutes before'
      : 'Reminder: none — it starts in under 10 minutes.';
  const sameDay = startAt.toDateString() === endAt.toDateString();
  const range = sameDay
    ? `${formatDateLong(startAt)}\n${formatClock(startAt)} – ${formatClock(endAt)}`
    : `${formatDateLong(startAt)} ${formatClock(startAt)} –\n${formatDateLong(endAt)} ${formatClock(endAt)}`;
  Alert.alert('Meeting scheduled', `"${call.title || 'Meeting'}"\n\n${range}\n\n${reminder}`);
}
