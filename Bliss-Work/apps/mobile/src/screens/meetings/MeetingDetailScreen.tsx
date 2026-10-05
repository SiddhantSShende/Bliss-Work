import { useMemo, useState } from 'react';
import { ArrowLeft, Hash, Share2, UserCircle, UserPlus, Users, Video } from 'lucide-react-native';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useCalls } from '../../calls/CallProvider';
import { useSession } from '@taskboard/app/store/session';
import { errorText } from '@taskboard/app/lib/errorText';
import { qk } from '../../hooks/queryKeys';
import { Avatar } from '../../components/Avatar';
import { MemberPickerSheet } from '../../components/MemberPickerSheet';
import { useDirectory } from '../../hooks/useDirectory';
import { usePresence } from '../../hooks/usePresence';
import { addMembersToCall, describeAddResult } from '../../lib/addMembers';
import { withAlpha } from '../../lib/color';
import { Card } from '../../components/Card';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import { mix } from '../../meetings/mix';
import { STATUS_TEXT, isOpen, participantsLabel, shortMeetingId, whenLabel } from '../../meetings/detailFormat';
import type { MeetingsStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MeetingsStackParamList, 'MeetingDetail'>;

const BASE = '#070a14';

/**
 * One meeting: a hero with the title, time, participant count and status, a
 * prominent Join button, then the meeting's details (short id + share invite,
 * organizer), its roster, and the lifecycle actions the API exposes —
 * Join (in-app: the LiveKit room via src/calls, never a browser), Start
 * (`startCall`, host/admin), Leave (`leaveCall`), End/Cancel for everyone
 * (`endCall`, hosts only), Add member (`addCallParticipant`). The server is the
 * authority on who may do what; a refusal is shown as-is.
 */
export function MeetingDetailScreen({ route, navigation }: Props) {
  const { callId } = route.params;
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api, config } = useRuntime();
  const { joinMeeting } = useCalls();
  const me = useSession((s) => s.user);
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const directory = useDirectory('');

  const { data: call, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: qk.call(callId),
    queryFn: () => api.call(callId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.call(callId) });
    void qc.invalidateQueries({ queryKey: qk.myCalls });
    void qc.invalidateQueries({ queryKey: qk.callHistory });
    void qc.invalidateQueries({ queryKey: qk.callsRangePrefix });
  };
  const opts = { onSuccess: refresh, onError: (e: unknown) => Alert.alert('Action failed', errorText(e)) };
  const start = useMutation({ mutationFn: () => api.startCall(callId), ...opts });
  const leave = useMutation({ mutationFn: () => api.leaveCall(callId), ...opts });
  const end = useMutation({
    mutationFn: () => api.endCall(callId),
    onSuccess: () => {
      refresh();
      navigation.goBack();
    },
    onError: opts.onError,
  });

  // Real names/avatars for the roster: the call DTO only carries a username.
  const byId = useMemo(() => new Map(directory.all.map((m) => [m.id, m])), [directory.all]);
  const online = usePresence(call?.participants.map((p) => p.userId) ?? []);
  const nameOf = (userId: string, fallback: string) => (userId === me?.id ? me.displayName : byId.get(userId)?.displayName ?? (fallback || userId.slice(0, 8)));

  // POST /calls/:id/participants (same call the web uses) — the server only lets a CURRENT participant of a
  // call that has not ended add someone from their own org, so the button is offered on exactly that condition.
  const iAmParticipant = !!call && !!me && call.participants.some((p) => p.userId === me.id && !p.leftAt);
  const addMembers = useMutation({
    mutationFn: (users: Parameters<typeof addMembersToCall>[1]) =>
      addMembersToCall((userId) => api.addCallParticipant(callId, userId), users, new Set(call?.participants.map((p) => p.userId) ?? [])),
    onSuccess: (result) => {
      refresh(); // roster comes back from the server, so invited members show up for real
      const { title, body } = describeAddResult(result);
      Alert.alert(title, body);
    },
    onError: (e) => Alert.alert("Couldn't add members", errorText(e)),
  });

  // A real invite link (POST /calls/:id/invites), shared through the system
  // share sheet. On a phone with BlissWork it opens the meeting in the app.
  const shareInvite = useMutation({
    mutationFn: async () => {
      const invite = await api.createCallInvite(callId);
      const url = `${config.webBaseUrl}/join?t=${encodeURIComponent(invite.token)}`;
      await Share.share({ message: `Join "${call?.title || 'the meeting'}" on BlissWork: ${url}` });
    },
    onError: (e) => Alert.alert("Couldn't create an invite link", errorText(e)),
  });

  const host = call?.participants.find((p) => p.role === 'HOST');
  const isHost = !!call && !!me && (call.createdBy === me.id || call.startedBy === me.id || call.participants.some((p) => p.userId === me.id && p.role === 'HOST'));
  const iAmIn = !!call && !!me && call.participants.some((p) => p.userId === me.id && p.joinedAt && !p.leftAt);
  const open = !!call && isOpen(call.status);

  const confirmEnd = () =>
    Alert.alert(call?.status === 'SCHEDULED' ? 'Cancel this meeting?' : 'End the meeting for everyone?', undefined, [
      { text: 'No', style: 'cancel' },
      { text: call?.status === 'SCHEDULED' ? 'Cancel meeting' : 'End meeting', style: 'destructive', onPress: () => end.mutate() },
    ]);

  // The hero is a dark, brand-tinted stage in every theme (like the meeting screen).
  const hero = [mix(BASE, colors.brandTo, isDark ? 0.34 : 0.42), mix(BASE, colors.brandFrom, 0.12)] as const;
  const live = call?.status === 'LIVE';

  return (
    <View style={styles.flex}>
      {isLoading ? (
        <View style={{ paddingTop: insets.top + 60 }}>
          <LoadingState label="Loading meeting..." />
        </View>
      ) : isError || !call ? (
        <View style={{ paddingTop: insets.top + 60 }}>
          <ErrorState title="Unable to load this meeting" error={error} onRetry={() => void refetch()} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} progressViewOffset={insets.top + 40} />}
          showsVerticalScrollIndicator={false}
        >
          <LinearGradient colors={hero} style={[styles.hero, { paddingTop: insets.top + 8 }]}>
            <View style={styles.heroBar}>
              <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={styles.heroBtn}>
                <ArrowLeft size={22} color="#ffffff" />
              </Pressable>
            </View>
            <View style={[styles.heroIcon, { backgroundColor: withAlpha(colors.accent, 0.28), borderColor: withAlpha(colors.accent, 0.6) }]}>
              <Video size={30} color="#ffffff" />
            </View>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {call.title || 'Meeting'}
            </Text>
            <Text style={styles.heroWhen}>{whenLabel(call.scheduledAt ?? call.startedAt, call.endsAt)}</Text>
            <View style={styles.chips}>
              <View style={styles.chip}>
                <Users size={14} color="#ffffff" />
                <Text style={styles.chipText}>{participantsLabel(call.participants.length)}</Text>
              </View>
              <View style={styles.chip}>
                <View style={[styles.dot, { backgroundColor: live ? '#22c55e' : call.status === 'SCHEDULED' ? '#f59e0b' : '#9ca3af' }]} />
                <Text style={styles.chipText}>{STATUS_TEXT[call.status]}</Text>
              </View>
            </View>
          </LinearGradient>

          <View style={styles.body}>
            {open ? (
              <Pressable
                onPress={() => joinMeeting(call.id, call.media, call.title || undefined)}
                accessibilityRole="button"
                accessibilityLabel="Join Meeting"
                style={({ pressed }) => [styles.join, { backgroundColor: colors.accent, opacity: pressed ? 0.9 : 1 }]}
              >
                <Video size={20} color={colors.accentFg} />
                <Text style={[styles.joinText, { color: colors.accentFg }]}>{live ? 'Join Meeting' : 'Open the room'}</Text>
              </Pressable>
            ) : (
              <View style={[styles.join, { backgroundColor: colors.surface2 }]}>
                <Text style={[styles.joinText, { color: colors.muted }]}>{call.status === 'CANCELLED' ? 'This meeting was cancelled' : 'This meeting has ended'}</Text>
              </View>
            )}

            {open ? (
              <View style={styles.actions}>
                {call.status === 'SCHEDULED' && isHost ? (
                  <ActionButton label="Start meeting" onPress={() => start.mutate()} busy={start.isPending} colors={colors} />
                ) : null}
                {live && iAmIn ? <ActionButton label="Leave meeting" onPress={() => leave.mutate()} busy={leave.isPending} colors={colors} /> : null}
                {isHost ? (
                  <ActionButton label={call.status === 'SCHEDULED' ? 'Cancel meeting' : 'End for everyone'} onPress={confirmEnd} busy={end.isPending} colors={colors} danger />
                ) : null}
              </View>
            ) : null}

            <Card noPadding style={styles.infoCard}>
              <InfoRow
                icon={<Hash size={18} color={colors.accent} />}
                label="Meeting ID"
                value={shortMeetingId(call.id)}
                colors={colors}
                action={
                  open && iAmParticipant ? (
                    <Pressable onPress={() => shareInvite.mutate()} disabled={shareInvite.isPending} hitSlop={10} accessibilityRole="button" accessibilityLabel="Share invite link" style={styles.iconAction}>
                      {shareInvite.isPending ? <ActivityIndicator size="small" color={colors.accent} /> : <Share2 size={18} color={colors.accent} />}
                    </Pressable>
                  ) : null
                }
              />
              <View style={styles.sep} />
              <InfoRow
                icon={host ? <Avatar name={nameOf(host.userId, host.username)} src={host.userId === me?.id ? me.avatarUrl : byId.get(host.userId)?.avatarUrl} size={26} /> : <UserCircle size={18} color={colors.accent} />}
                label="Organizer"
                value={host ? nameOf(host.userId, host.username) : '—'}
                colors={colors}
              />
            </Card>

            <Card style={styles.card}>
              <View style={styles.sectionRow}>
                <Text style={styles.section}>Participants ({call.participants.length})</Text>
                {open && iAmParticipant ? (
                  <Pressable onPress={() => setPickerOpen(true)} style={styles.addBtn} accessibilityRole="button" accessibilityLabel="Add member">
                    <UserPlus size={15} color={colors.accent} />
                    <Text style={styles.addBtnText}>Add member</Text>
                  </Pressable>
                ) : null}
              </View>
              {call.participants.length === 0 ? <Text style={styles.personMeta}>No participants yet.</Text> : null}
              {call.participants.map((p) => {
                const member = byId.get(p.userId);
                const name = nameOf(p.userId, p.username);
                return (
                  <View key={p.userId} style={styles.person}>
                    <Avatar name={name} src={p.userId === me?.id ? me.avatarUrl : member?.avatarUrl} size={36} online={online.has(p.userId)} />
                    <Text style={styles.personName} numberOfLines={1}>
                      {name}
                      {p.userId === me?.id ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.personMeta}>{p.role === 'HOST' ? 'Host' : p.joinedAt && !p.leftAt ? 'In the room' : p.leftAt ? 'Left' : 'Invited'}</Text>
                  </View>
                );
              })}
            </Card>
          </View>
        </ScrollView>
      )}

      <MemberPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add members"
        alreadyIds={call?.participants.map((p) => p.userId) ?? []}
        alreadyLabel="Already in this meeting"
        confirmLabel={(n) => (n > 1 ? `Add ${n} members` : 'Add member')}
        onConfirm={(users) => addMembers.mutateAsync(users).catch(() => undefined)}
      />
    </View>
  );
}

function ActionButton({ label, onPress, busy, danger, colors }: { label: string; onPress: () => void; busy?: boolean; danger?: boolean; colors: ThemeColors }) {
  const tint = danger ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => ({
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: tint,
        opacity: busy ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={tint} /> : <Text style={{ color: tint, fontSize: 15, fontWeight: '700' }}>{label}</Text>}
    </Pressable>
  );
}

function InfoRow({ icon, label, value, colors, action }: { icon: React.ReactNode; label: string; value: string; colors: ThemeColors; action?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: 14 }}>
      <View style={{ width: 28, alignItems: 'center' }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 12, color: colors.muted, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: 15, color: colors.fg, fontWeight: '700', marginTop: 1 }} numberOfLines={1}>
          {value}
        </Text>
      </View>
      {action}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    hero: { paddingHorizontal: spacing.lg, paddingBottom: 56, alignItems: 'center' },
    heroBar: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', height: 44, alignItems: 'center' },
    heroBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
    heroIcon: { width: 68, height: 68, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, marginTop: 4 },
    heroTitle: { color: '#ffffff', fontSize: 24, fontWeight: '800', textAlign: 'center', marginTop: 14 },
    heroWhen: { color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '500', marginTop: 6, textAlign: 'center' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 14 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.14)' },
    chipText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
    dot: { width: 8, height: 8, borderRadius: 4 },
    body: { paddingHorizontal: spacing.lg, marginTop: -30, gap: spacing.md },
    join: { height: 54, borderRadius: 27, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
    joinText: { fontSize: 17, fontWeight: '800' },
    actions: { gap: spacing.sm },
    infoCard: { overflow: 'hidden' },
    sep: { height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.border, marginLeft: spacing.lg + 28 + spacing.md },
    iconAction: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    card: { gap: spacing.sm },
    section: { fontSize: 13, fontWeight: '700', color: colors.muted },
    sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    addBtnText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    personName: { flex: 1, fontSize: 14, color: colors.fg },
    personMeta: { fontSize: 12, color: colors.muted },
  });
}
