import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RefreshCw,
  SwitchCamera,
  UserPlus,
  Users,
  Video as VideoIcon,
  VideoOff,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { RTCView } from '@livekit/react-native-webrtc';
import { VideoTrack } from '@livekit/react-native';
import type { UserDTO } from '@taskboard/shared';
import { Avatar } from '../components/Avatar';
import { Logo } from '../components/Logo';
import { MemberPickerSheet } from '../components/MemberPickerSheet';
import { useGlass } from '../components/glass/GlassProvider';
import { withAlpha } from '../lib/color';
import { spacing, type ThemeColors } from '../constants/theme';
import { useAppTheme, useThemeColors } from '../theme/ThemeProvider';
import { useCalls, useDirectCall, useRoomCall } from './CallProvider';
import { SlideToAnswer } from './SlideToAnswer';
import { useCallerProfile } from './useCallerProfile';
import { MeetingRoom } from '../meetings/MeetingRoom';
import { MeetingBar } from '../meetings/MeetingBar';
import { CallPip, MeetingPip } from '../meetings/MeetingPip';
import { meetingUi, useMeetingUi } from '../meetings/meetingUi';
import { usePip } from '../meetings/usePip';
import type { CallSnapshot } from './callController';
import type { RoomParticipantView, RoomSnapshot } from './roomController';
import {
  alreadyInCallIds,
  backAction,
  pendingInvitees,
  summarizeOutcome,
  type AddProgress,
  type OutcomeNotice,
  type PendingInvitee,
} from './addPeople';

/**
 * The whole in-app calling UI: ring screen, active 1:1 call, room call
 * (meeting / channel), and the failed/ended states. Nothing here opens a browser.
 *
 * LAYERING. Real background blur needs the blurred app to be a SIBLING of the
 * blur (see components/glass/GlassProvider.tsx). So `CallOverlay` renders
 * nothing itself: it publishes `CallLayer` into GlassProvider's overlay layer,
 * which stacks
 *
 *   [ app, inside BlurTargetView ]
 *     -> full-screen BlurView (blurTarget = the app)
 *     -> theme-tinted translucent wash
 *     -> call UI  (controls are siblings of the blur, never its children)
 *
 * and is absolutely filled over the whole window (status/navigation bars
 * included; only the controls sit inside the safe-area insets). The Add-member
 * picker is a later layer in the same provider, so it stacks above the call.
 */

const LAYER_ID = 'call-overlay';
const FADE_IN_MS = 220;
const FADE_OUT_MS = 160;

export function CallOverlay() {
  const direct = useDirectCall();
  const room = useRoomCall();
  const { direct: dc, room: rc } = useCalls();
  const glass = useGlass();

  const visible = direct.phase !== 'idle' || room.phase !== 'idle';

  // Stay mounted a moment after the last call state so the layer can fade out,
  // and so a 1:1 -> room hand-over (which passes through "idle" for a tick)
  // does not tear the blur down and replay its fade-in.
  const [lingering, setLingering] = useState(visible);
  useEffect(() => {
    if (visible) {
      setLingering(true);
      return;
    }
    const t = setTimeout(() => setLingering(false), FADE_OUT_MS + 120);
    return () => clearTimeout(t);
  }, [visible]);
  const mounted = visible || lingering;

  // Hardware Back never silently leaves a live call: a finished call screen is
  // dismissed, a live call asks first, a ring is left alone.
  const asking = useRef(false);
  const { minimized, inPip } = useMeetingUi();
  useEffect(() => {
    // Minimized: the user is using the rest of the app, so Back is theirs.
    if (!visible || minimized || inPip) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const dp = dc.getSnapshot().phase;
      const rp = rc.getSnapshot().phase;
      // A live meeting: Back minimizes it (like every meeting app) instead of
      // hanging up. Leaving is an explicit choice (End -> Leave).
      if (dp === 'idle' && (rp === 'connected' || rp === 'reconnecting')) {
        meetingUi.minimize();
        return true;
      }
      const action = backAction(dp, rp);
      if (action === 'dismiss') {
        if (dp !== 'idle') dc.hangup();
        else rc.leave();
      } else if (action === 'confirm-leave' && !asking.current) {
        asking.current = true;
        Alert.alert(
          'Leave the call?',
          undefined,
          [
            { text: 'Stay in call', style: 'cancel', onPress: () => (asking.current = false) },
            {
              text: 'Leave',
              style: 'destructive',
              onPress: () => {
                asking.current = false;
                if (dc.getSnapshot().phase !== 'idle') dc.hangup();
                else rc.leave();
              },
            },
          ],
          { cancelable: true, onDismiss: () => (asking.current = false) },
        );
      }
      return true;
    });
    return () => sub.remove();
  }, [visible, minimized, inPip, dc, rc]);

  useEffect(() => {
    if (!glass) return;
    if (mounted) glass.setLayer(LAYER_ID, <CallLayer />);
    else glass.removeLayer(LAYER_ID);
  }, [glass, mounted]);
  const removeLayer = glass?.removeLayer;
  useEffect(() => () => removeLayer?.(LAYER_ID), [removeLayer]);

  // Outside a GlassProvider (should not happen in the app) fall back to an
  // inline layer: no real Android blur, but a legible opaque-ish wash.
  if (!glass) return mounted ? <CallLayer /> : null;
  return null;
}

// ── the layer ───────────────────────────────────────────────────────────────

/** Blur strength over the app behind the call. */
const BLUR_INTENSITY = Platform.OS === 'ios' ? 65 : 75;

function CallLayer() {
  const direct = useDirectCall();
  const room = useRoomCall();
  const { direct: dc, room: rc } = useCalls();
  const { colors, isDark } = useAppTheme();
  const glass = useGlass();

  const showDirect = direct.phase !== 'idle';
  const showRoom = !showDirect && room.phase !== 'idle';
  const active = showDirect || showRoom;

  // Picture-in-Picture / minimize: only for a call that is really connected.
  const roomLive = showRoom && (room.phase === 'connected' || room.phase === 'reconnecting');
  const directLive = showDirect && (direct.phase === 'connected' || direct.phase === 'reconnecting');
  const callLive = roomLive || directLive;
  // Real system PiP is a window drawn ON TOP of whatever the user switches to.
  // While screen sharing, that window would be captured too (the meeting
  // recursively appearing inside its own shared screen), so PiP is disarmed
  // for the duration of the share: leaving the app just backgrounds it
  // normally, and the capture shows exactly what the user switched to.
  usePip(callLive && !room.sharing);
  const { minimized, inPip } = useMeetingUi();
  // The meeting screen is an opaque stage; blurring the app under it is wasted work.
  const meetingScreen = showRoom && (room.phase === 'joining' || room.phase === 'waiting' || room.phase === 'connected' || room.phase === 'reconnecting');

  // Fade the whole layer (blur + wash + UI together) with the native driver, so
  // there is no white/black flash while the blur is set up.
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: active ? 1 : 0, duration: active ? FADE_IN_MS : FADE_OUT_MS, useNativeDriver: true }).start();
  }, [active, fade]);

  // ── Add member (shared by 1:1 and room calls) ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<OutcomeNotice | null>(null);
  const [progress, setProgress] = useState<AddProgress | null>(null);
  const [invited, setInvited] = useState<PendingInvitee[]>([]);

  // Reset only once the call is really over: a 1:1 -> room hand-over passes
  // through "nothing active" for an instant and must keep its notice/invitees.
  useEffect(() => {
    if (active) return;
    const t = setTimeout(() => {
      setPickerOpen(false);
      setNotice(null);
      setProgress(null);
      setInvited([]);
    }, 600);
    return () => clearTimeout(t);
  }, [active]);

  // Successes fade away on their own; anything that failed stays until dismissed.
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const t = setTimeout(() => setNotice((n) => (n === notice ? null : n)), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const onConfirmAdd = useCallback(
    async (users: UserDTO[]) => {
      const people = users.map((u) => ({ id: u.id, name: u.displayName }));
      setNotice(null);
      setProgress({ done: 0, total: people.length });
      try {
        const outcome =
          dc.getSnapshot().phase !== 'idle' ? await dc.addPeople(people, setProgress) : await rc.addPeople(people, setProgress);
        const now = Date.now();
        setInvited((prev) => [...prev, ...outcome.added.map((a) => ({ ...a, at: now }))]);
        setNotice(summarizeOutcome(outcome));
      } catch (e) {
        // addPeople never throws by contract; if that is ever broken the user
        // must still see something.
        setNotice({ tone: 'error', text: `Couldn't add people${e instanceof Error ? `: ${e.message}` : ''}` });
      } finally {
        setProgress(null);
      }
    },
    [dc, rc],
  );

  const joinedIds = room.participants.map((p) => p.identity);
  const alreadyIds = useMemo(
    () => alreadyInCallIds(joinedIds, invited, [direct.peerId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [joinedIds.join('|'), invited, direct.peerId],
  );

  const addProps: AddProps = {
    open: () => setPickerOpen(true),
    notice,
    dismissNotice: () => setNotice(null),
    progress,
    invited,
  };

  const androidTarget = Platform.OS === 'android' ? glass?.targetRef : undefined;
  const hasRealBlur = Platform.OS === 'ios' || !!androidTarget;
  const wash = withAlpha(colors.bgSolid, hasRealBlur ? (isDark ? 0.6 : 0.5) : 0.96);

  // The system PiP window: the compact view only.
  if (inPip && callLive) {
    return (
      <Animated.View style={[styles.layer, { opacity: fade }]} pointerEvents="auto">
        {roomLive ? <MeetingPip room={room} /> : <CallPip call={direct} />}
      </Animated.View>
    );
  }

  // Minimized: only the slim return bar; the app underneath stays usable.
  if (minimized && callLive) {
    return (
      <Animated.View style={[styles.layer, { opacity: fade }]} pointerEvents="box-none">
        <MeetingBar />
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.layer, { opacity: fade }]} pointerEvents={active ? 'auto' : 'none'}>
      {/* 1. Full-screen blur of the app behind the call. */}
      {hasRealBlur && !meetingScreen ? (
        <BlurView
          intensity={BLUR_INTENSITY}
          tint={isDark ? 'dark' : 'light'}
          blurTarget={androidTarget}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {/* 2. Theme-tinted translucent wash: keeps light light and dark dark. */}
      {!meetingScreen ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: wash }]} /> : null}
      {/* 3. Call UI, sharp, above both. */}
      {showDirect ? <DirectCallView s={direct} add={addProps} /> : meetingScreen ? <MeetingRoom s={room} add={addProps} /> : showRoom ? <RoomCallView s={room} add={addProps} /> : null}

      {/* Mounted only while open (it loads and watches the whole directory). It
          publishes its own GlassProvider layer AFTER the call layer, so it
          stacks above the call screen. */}
      {pickerOpen && active ? (
        <MemberPickerSheet
          visible
          onClose={() => setPickerOpen(false)}
          title="Add people to the call"
          confirmLabel={(n) => (n > 1 ? `Add ${n} people` : 'Add member')}
          alreadyIds={alreadyIds}
          alreadyLabel="In this call"
          onConfirm={onConfirmAdd}
        />
      ) : null}
    </Animated.View>
  );
}

interface AddProps {
  open: () => void;
  notice: OutcomeNotice | null;
  dismissNotice: () => void;
  progress: AddProgress | null;
  invited: PendingInvitee[];
}

// ── shared bits ─────────────────────────────────────────────────────────────

function useElapsed(since?: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}

function Brand({ size = 22 }: { size?: number }) {
  const colors = useThemeColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <Logo size={size} />
      <Text style={{ color: colors.fg, fontSize: 14, fontWeight: '700', letterSpacing: 0.3 }}>BlissWork</Text>
    </View>
  );
}

/** A translucent glass fill for a control. The full-screen blur is already
 *  behind it, so it needs no blur of its own on Android (and six extra
 *  Dimezis views would be a real cost); over live video, where the layer's blur
 *  cannot reach, iOS blurs the video natively and Android uses a dark wash. */
function useControlSkin(onVideo?: boolean) {
  const { colors, isDark } = useAppTheme();
  return useMemo(() => {
    if (onVideo) {
      return {
        bg: 'rgba(0,0,0,0.42)',
        border: 'rgba(255,255,255,0.28)',
        ink: '#ffffff',
        blur: Platform.OS === 'ios',
      };
    }
    return {
      bg: withAlpha(colors.surface, isDark ? 0.55 : 0.66),
      border: withAlpha('#ffffff', isDark ? 0.16 : 0.75),
      ink: colors.fg,
      blur: false,
    };
  }, [colors, isDark, onVideo]);
}

interface CtrlProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  /** Off/disabled look (e.g. muted). */
  off?: boolean;
  tone?: 'glass' | 'danger' | 'success';
  size?: number;
  /** Shown over live video: white label with a shadow instead of theme ink. */
  onVideo?: boolean;
}

/** A round call control: glass by default, sharp icon on top. */
function Ctrl({ icon: Icon, label, onPress, off, tone = 'glass', size = 58, onVideo }: CtrlProps) {
  const colors = useThemeColors();
  const skin = useControlSkin(onVideo);
  const solid = tone === 'danger' ? colors.danger : tone === 'success' ? colors.success : undefined;
  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
        {({ pressed }) =>
          solid ? (
            <View
              style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: solid,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.8 : 1,
              }}
            >
              <Icon size={size * 0.42} color="#ffffff" />
            </View>
          ) : (
            <View
              style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                overflow: 'hidden',
                borderWidth: StyleSheet.hairlineWidth * 2,
                borderColor: skin.border,
                opacity: pressed ? 0.8 : 1,
              }}
            >
              {skin.blur ? <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} /> : null}
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: skin.bg }]} />
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={size * 0.4} color={off ? colors.danger : skin.ink} />
              </View>
            </View>
          )
        }
      </Pressable>
      <Text
        style={
          onVideo
            ? { color: '#ffffff', fontSize: 11, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.75)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } }
            : { color: colors.fg, fontSize: 11, fontWeight: '600' }
        }
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/** The "Add member" call-to-action: person-plus icon + label in a glass pill. */
function AddMemberButton({ onPress, disabled, onVideo, busy }: { onPress: () => void; disabled?: boolean; onVideo?: boolean; busy?: boolean }) {
  const colors = useThemeColors();
  const skin = useControlSkin(onVideo);
  const ink = onVideo ? '#ffffff' : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Add member"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      hitSlop={6}
    >
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 16,
            height: 42,
            borderRadius: 21,
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderColor: onVideo ? skin.border : colors.accent,
            opacity: disabled ? 0.55 : pressed ? 0.8 : 1,
          }}
        >
          {skin.blur ? <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} /> : null}
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: skin.bg }]} />
          {busy ? <ActivityIndicator size="small" color={ink} /> : <UserPlus size={18} color={ink} />}
          <Text style={{ color: ink, fontSize: 14, fontWeight: '700' }}>Add member</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Result of the last Add member attempt: visible, never silent. */
function AddNotice({ notice, progress, onDismiss, onVideo }: { notice: OutcomeNotice | null; progress: AddProgress | null; onDismiss: () => void; onVideo?: boolean }) {
  const colors = useThemeColors();
  const skin = useControlSkin(onVideo);
  if (!notice && !progress) return null;
  const tone = notice?.tone;
  const ink = tone === 'error' ? colors.danger : tone === 'mixed' ? colors.danger : tone === 'success' ? colors.success : skin.ink;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        alignSelf: 'stretch',
        marginHorizontal: spacing.lg,
        marginTop: spacing.sm,
        padding: spacing.md,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: skin.border,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
      }}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: onVideo ? 'rgba(0,0,0,0.6)' : withAlpha(colors.surface, 0.8) }]} />
      {progress && !notice ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      <Text style={{ flex: 1, color: onVideo ? '#ffffff' : ink, fontSize: 13, fontWeight: '600' }}>
        {notice ? notice.text : `Adding ${Math.min(progress!.done + 1, progress!.total)} of ${progress!.total}${progress!.current ? `: ${progress!.current.name}` : ''}…`}
      </Text>
      {notice ? (
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
          <X size={16} color={onVideo ? '#ffffff' : colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ── ring screen (1:1 and room invites) ──────────────────────────────────────

function RingView({
  callerId,
  name,
  context,
  media,
  onAccept,
  onDecline,
}: {
  /** The caller's user id, when known — resolves their photo and @username. */
  callerId?: string;
  /** Name from the ring itself; the directory's full name replaces it once known. */
  name: string;
  /** Meeting/channel title for a room invite. */
  context?: string;
  media: 'audio' | 'video';
  onAccept: () => void;
  onDecline: () => void;
}) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const caller = useCallerProfile(callerId, name);
  const kind = media === 'video' ? 'BlissWork Video Call' : 'BlissWork Audio Call';
  return (
    <View style={[styles.fill, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl }]}>
      <View style={styles.top}>
        <Brand size={34} />
      </View>
      <View style={styles.center}>
        <Text style={[styles.ringLabel, { color: colors.muted }]}>Incoming Call</Text>
        {/* `Avatar` shows initials whenever there is no photo, never a broken image. */}
        <Avatar name={caller.name} src={caller.avatarUrl} size={128} />
        <Text style={[styles.name, { color: colors.fg }]} numberOfLines={2}>
          {caller.name}
        </Text>
        {caller.username ? (
          <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
            @{caller.username}
          </Text>
        ) : null}
        <Text style={[styles.kind, { color: colors.accent }]}>{kind}</Text>
        {context ? (
          <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
            {context}
          </Text>
        ) : null}
      </View>
      <SlideToAnswer media={media} onAnswer={onAccept} onDecline={onDecline} />
    </View>
  );
}

// ── 1:1 call ────────────────────────────────────────────────────────────────

function DirectCallView({ s, add }: { s: CallSnapshot; add: AddProps }) {
  const { direct } = useCalls();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const styles2 = useMemo(() => createStyles(colors), [colors]);
  const elapsed = useElapsed(s.phase === 'connected' || s.phase === 'reconnecting' ? s.connectedAt : undefined);
  const name = s.peerName ?? 'Contact';

  if (s.phase === 'incoming') {
    return (
      <RingView
        callerId={s.peerId}
        name={name}
        media={s.media ?? 'audio'}
        onAccept={() => void direct.accept()}
        onDecline={() => direct.decline()}
      />
    );
  }

  const dead = s.phase === 'ended' || s.phase === 'rejected' || s.phase === 'failed';
  const status =
    s.phase === 'outgoing'
      ? 'Calling…'
      : s.phase === 'connecting'
        ? 'Connecting…'
        : s.phase === 'reconnecting'
          ? 'Reconnecting…'
          : s.phase === 'connected'
            ? elapsed
            : s.phase === 'rejected'
              ? 'Call declined'
              : s.phase === 'failed'
                ? (s.reason ?? 'Call connection failed')
                : (s.reason ?? 'Call ended');

  const remoteVisible = (s.peerCamOn || s.peerSharing) && !!s.remoteStream && (s.phase === 'connected' || s.phase === 'reconnecting');
  const camOn = s.camOn && !!s.localStream;
  const showAdd = s.phase === 'connected';
  const addReady = !!s.recordId && !add.progress;

  return (
    <View style={styles.fill}>
      {remoteVisible ? (
        <RTCView streamURL={s.remoteStream!.toURL()} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : null}
      {remoteVisible ? <View style={styles2.scrim} pointerEvents="none" /> : null}

      <View style={[styles.fill, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.top}>
          <Brand />
        </View>

        {!remoteVisible ? (
          <View style={styles.center}>
            <Avatar name={name} size={112} />
            <Text style={[styles.name, { color: colors.fg }]} numberOfLines={2}>
              {name}
            </Text>
            <Text style={[styles.sub, { color: s.phase === 'failed' ? colors.danger : colors.muted }]}>{status}</Text>
            {showAdd ? (
              <View style={{ marginTop: spacing.md }}>
                <AddMemberButton
                  onPress={() => (s.recordId ? add.open() : void 0)}
                  disabled={!addReady}
                  busy={!!add.progress}
                />
                {!s.recordId ? <Text style={[styles.hint, { color: colors.muted }]}>Getting the call ready…</Text> : null}
              </View>
            ) : null}
            <AddNotice notice={add.notice} progress={add.progress} onDismiss={add.dismissNotice} />
          </View>
        ) : (
          <>
            <View style={styles2.overVideoHeader}>
              <Text style={styles2.overName} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles2.overStatus}>{status}</Text>
              {showAdd ? (
                <View style={{ marginTop: spacing.sm }}>
                  <AddMemberButton onPress={() => (s.recordId ? add.open() : void 0)} disabled={!addReady} busy={!!add.progress} onVideo />
                </View>
              ) : null}
            </View>
            <AddNotice notice={add.notice} progress={add.progress} onDismiss={add.dismissNotice} onVideo />
          </>
        )}

        {camOn ? (
          <View style={[styles2.pip, { top: insets.top + 56 }]}>
            <RTCView key={s.camEpoch} streamURL={s.localStream!.toURL()} style={styles.fill} objectFit="cover" mirror={s.camMirror} zOrder={1} />
          </View>
        ) : null}

        {dead ? (
          <View style={styles2.deadActions}>
            {s.phase === 'failed' ? (
              <Ctrl icon={RefreshCw} label="Retry" onPress={() => void direct.retry()} size={64} />
            ) : null}
            <Ctrl icon={PhoneOff} label={s.phase === 'failed' ? 'End call' : 'Close'} onPress={() => direct.hangup()} tone="danger" size={64} />
          </View>
        ) : (
          <View style={styles2.controls}>
            <Ctrl icon={s.micOn ? Mic : MicOff} label={s.micOn ? 'Mute' : 'Unmute'} off={!s.micOn} onPress={() => direct.toggleMic()} onVideo={remoteVisible} />
            <Ctrl icon={s.camOn ? VideoIcon : VideoOff} label={s.camOn ? 'Camera' : 'Camera off'} off={!s.camOn} onPress={() => void direct.toggleCam()} onVideo={remoteVisible} />
            {s.camOn ? <Ctrl icon={SwitchCamera} label="Flip" onPress={() => void direct.switchCamera()} onVideo={remoteVisible} /> : null}
            <Ctrl icon={s.speakerOn ? Volume2 : VolumeX} label="Speaker" off={!s.speakerOn} onPress={() => direct.toggleSpeaker()} onVideo={remoteVisible} />
            <Ctrl icon={PhoneOff} label="End" tone="danger" onPress={() => direct.hangup()} onVideo={remoteVisible} />
          </View>
        )}
      </View>
    </View>
  );
}

// ── room call (meeting / channel) ───────────────────────────────────────────

function RoomCallView({ s, add }: { s: RoomSnapshot; add: AddProps }) {
  const { room } = useCalls();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const styles2 = useMemo(() => createStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const elapsed = useElapsed(s.phase === 'connected' || s.phase === 'reconnecting' ? s.connectedAt : undefined);
  const title = s.title || (s.adhoc ? 'Conference call' : 'Meeting');
  const now = useNow(add.invited.length > 0);

  const ringing = pendingInvitees(add.invited, s.participants.map((p) => p.identity), now);

  if (s.phase === 'ringing') {
    return (
      <RingView
        callerId={s.inviterId}
        name={s.inviter ?? title}
        context={s.inviter ? title : undefined}
        media={s.media}
        onAccept={() => void room.join(s.callId!, s.media, s.title)}
        onDecline={() => room.decline()}
      />
    );
  }

  const dead = s.phase === 'ended' || s.phase === 'failed';
  const status =
    s.phase === 'joining'
      ? 'Joining…'
      : s.phase === 'waiting'
        ? s.canStart
          ? 'Not started yet'
          : 'Waiting for the host to start'
        : s.phase === 'reconnecting'
          ? 'Reconnecting…'
          : s.phase === 'connected'
            ? `${s.participants.length} in call · ${elapsed}`
            : (s.reason ?? (s.phase === 'failed' ? 'Call connection failed' : 'Call ended'));

  const leave = () => {
    if (s.isHost && s.phase === 'connected') {
      Alert.alert('Leave call', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', onPress: () => room.leave() },
        { text: 'End for everyone', style: 'destructive', onPress: () => room.endForAll() },
      ]);
    } else {
      room.leave();
    }
  };

  const cols = s.participants.length <= 1 ? 1 : 2;
  const gap = spacing.sm;
  const tileW = (width - spacing.lg * 2 - gap * (cols - 1)) / cols;
  const tileH = cols === 1 ? tileW * 1.25 : tileW * 1.2;

  return (
    <View style={[styles.fill, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}>
      <View style={styles.top}>
        <Brand />
      </View>
      <View style={styles2.roomHeader}>
        <Text style={[styles.name, { color: colors.fg, fontSize: 20, marginTop: 0 }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.sub, { color: s.phase === 'failed' ? colors.danger : colors.muted }]}>{status}</Text>
        {s.phase === 'connected' || s.phase === 'reconnecting' ? (
          <View style={{ marginTop: spacing.sm }}>
            <AddMemberButton onPress={add.open} disabled={s.phase !== 'connected' || !!add.progress} busy={!!add.progress} />
          </View>
        ) : null}
      </View>
      <AddNotice notice={add.notice} progress={add.progress} onDismiss={add.dismissNotice} />
      {ringing.length > 0 ? (
        <View style={styles2.ringingRow}>
          {ringing.map((p) => (
            <View key={p.id} style={[styles2.ringingChip, { backgroundColor: colors.accentSoft }]}>
              <Avatar name={p.name} size={20} />
              <Text style={{ color: colors.fg, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
                {p.name} · Ringing…
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {s.phase === 'connected' || s.phase === 'reconnecting' ? (
        <FlatList
          key={cols}
          data={s.participants}
          numColumns={cols}
          keyExtractor={(p) => p.identity}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, gap }}
          columnWrapperStyle={cols > 1 ? { gap } : undefined}
          renderItem={({ item }) => <Tile p={item} w={tileW} h={tileH} colors={colors} />}
          style={styles.fill}
        />
      ) : (
        <View style={styles.center}>
          <View style={[styles2.waitIcon, { backgroundColor: colors.accentSoft }]}>
            <Users size={36} color={colors.accent} />
          </View>
        </View>
      )}

      {dead ? (
        <View style={styles2.deadActions}>
          {s.phase === 'failed' ? <Ctrl icon={RefreshCw} label="Retry" onPress={() => room.retry()} size={64} /> : null}
          <Ctrl icon={PhoneOff} label={s.phase === 'failed' ? 'End call' : 'Close'} onPress={() => room.leave()} tone="danger" size={64} />
        </View>
      ) : s.phase === 'waiting' || s.phase === 'joining' ? (
        <View style={styles2.deadActions}>
          {s.phase === 'waiting' && s.canStart ? (
            <Ctrl icon={VideoIcon} label="Start now" onPress={() => void room.startNow()} tone="success" size={64} />
          ) : null}
          <Ctrl icon={PhoneOff} label="Leave" onPress={() => room.leave()} tone="danger" size={64} />
        </View>
      ) : (
        <View style={styles2.controls}>
          <Ctrl icon={s.micOn ? Mic : MicOff} label={s.micOn ? 'Mute' : 'Unmute'} off={!s.micOn} onPress={() => void room.toggleMic()} />
          <Ctrl icon={s.camOn ? VideoIcon : VideoOff} label={s.camOn ? 'Camera' : 'Camera off'} off={!s.camOn} onPress={() => void room.toggleCam()} />
          {s.camOn ? <Ctrl icon={SwitchCamera} label="Flip" onPress={() => void room.switchCamera()} /> : null}
          <Ctrl icon={s.speakerOn ? Volume2 : VolumeX} label="Speaker" off={!s.speakerOn} onPress={() => room.toggleSpeaker()} />
          <Ctrl icon={PhoneOff} label="Leave" tone="danger" onPress={leave} />
        </View>
      )}
    </View>
  );
}

/** A participant tile: a translucent panel on the blurred layer, video (if any)
 *  above it, label sharp on top. */
function Tile({ p, w, h, colors }: { p: RoomParticipantView; w: number; h: number; colors: ThemeColors }) {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        width: w,
        height: h,
        borderRadius: 18,
        overflow: 'hidden',
        backgroundColor: withAlpha(colors.surface, isDark ? 0.55 : 0.66),
        borderColor: p.speaking ? colors.accent : colors.border,
        borderWidth: p.speaking ? 2 : 1,
      }}
    >
      {p.camOn && p.videoRef ? (
        <VideoTrack
          trackRef={p.videoRef as never}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={p.isLocal && p.mirror !== false}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Avatar name={p.name} size={Math.min(72, w * 0.4)} />
        </View>
      )}
      <View style={tileStyles.label}>
        {!p.micOn ? <MicOff size={12} color="#ffffff" /> : null}
        <Text style={tileStyles.labelText} numberOfLines={1}>
          {p.isLocal ? 'You' : p.name}
        </Text>
      </View>
    </View>
  );
}

const tileStyles = StyleSheet.create({
  label: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    maxWidth: '85%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  labelText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
});

const styles = StyleSheet.create({
  // The layer fills the WHOLE window (status and navigation bars included; the
  // controls inside it apply the safe-area insets themselves). zIndex/elevation
  // keep it above the tab bar when rendered without a GlassProvider.
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 3000, elevation: 3000 },
  fill: { flex: 1 },
  top: { alignItems: 'center', paddingVertical: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl },
  name: { fontSize: 26, fontWeight: '800', textAlign: 'center', marginTop: spacing.md },
  sub: { fontSize: 15, fontWeight: '500', textAlign: 'center' },
  ringLabel: { fontSize: 14, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: spacing.sm },
  kind: { fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 2 },
  hint: { fontSize: 12, textAlign: 'center', marginTop: 6 },
});

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.28)' },
    overVideoHeader: { alignItems: 'center', gap: 2, paddingHorizontal: spacing.xl },
    overName: { color: '#ffffff', fontSize: 20, fontWeight: '800' },
    overStatus: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '500' },
    pip: {
      position: 'absolute',
      right: spacing.lg,
      width: 104,
      height: 148,
      borderRadius: 16,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.7)',
      backgroundColor: '#000000',
    },
    controls: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      marginTop: 'auto',
      paddingTop: spacing.md,
    },
    deadActions: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xl, marginTop: 'auto', paddingTop: spacing.md },
    roomHeader: { alignItems: 'center', gap: 2, paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
    ringingRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    ringingChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: 14, maxWidth: 220 },
    waitIcon: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  });
}
