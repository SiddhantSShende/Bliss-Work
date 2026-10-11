import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Hand,
  Info,
  MoreHorizontal,
  Mic,
  MicOff,
  MoreVertical,
  PhoneOff,
  PictureInPicture2,
  ScreenShare,
  ScreenShareOff,
  StickyNote,
  SwitchCamera,
  UserPlus,
  Users,
  Video as VideoIcon,
  VideoOff,
  MessageCircle,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurTargetView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCalls, useMeetingData } from '../calls/CallProvider';
import type {
  AddProgress,
  OutcomeNotice,
  PendingInvitee,
} from '../calls/addPeople';
import type {
  RoomParticipantView,
  RoomSnapshot,
} from '../calls/roomController';
import { StageBlurTarget, GlassPanel } from './Glass';
import {
  formatElapsed,
  participantCountLabel,
  pickStage,
  updateLastSpoke,
} from './layout';
import { ControlButton, EndButton } from './MeetingControls';
import { LeaveDialog, MeetingMenu, type MenuItem } from './MeetingOverlays';
import { MeetingPanel, type PanelTab } from './MeetingPanel';
import { ShareSheet } from './ShareSheet';
import { MeetingStage } from './MeetingStage';
import { meetingUi } from './meetingUi';
import { pip } from './pip';
import { useClock } from './useClock';
import { useMeetingSkin } from './skin';
import { CONFERENCE_TITLE } from '../calls/conferenceCall';

/** The "Add member" hooks CallOverlay owns (picker, progress, outcome). */
export interface MeetingAddUi {
  open: () => void;
  notice: OutcomeNotice | null;
  dismissNotice: () => void;
  progress: AddProgress | null;
  invited: PendingInvitee[];
}

const HEADER_H = 56;
/** Controls fade away after this long with no touch (any tap brings them back). */
const AUTO_HIDE_MS = 5000;

/**
 * The full-screen in-app meeting: header (minimize · title · clock · people ·
 * menu), the stage (active speaker / shared screen / pinned / grid), the
 * control row (Share · Mute · Camera · Members · Chat · Notes) and End.
 *
 * Everything drives the real room: mute/camera publish or unpublish the
 * tracks, Share starts MediaProjection capture, chat/notes ride the meeting's
 * data channel, Add member calls the meeting's participants endpoint. Sheets,
 * the menu and the leave dialog blur the LIVE STAGE behind them (see Glass.tsx).
 */
export function MeetingRoom({
  s,
  add,
}: {
  s: RoomSnapshot;
  add: MeetingAddUi;
}) {
  const skin = useMeetingSkin();
  const { room } = useCalls();
  const data = useMeetingData();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const stageRef = useRef<View>(null);

  const [tab, setTab] = useState<PanelTab | null>(null);
  const [menu, setMenu] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [lastSpoke, setLastSpoke] = useState<Record<string, number>>({});
  const [controlsH, setControlsH] = useState(landscape ? 84 : 150);
  const [pipSupported, setPipSupported] = useState(false);
  const kb = useKeyboardOffset();

  // Tap the video to hide / show the header + controls. They are OVERLAID, not
  // laid out: the stage keeps its size either way, so nothing jumps.
  const [chrome, setChrome] = useState(true);
  const [touches, setTouches] = useState(0);
  const chromeAnim = useRef(new Animated.Value(1)).current;
  const toggleChrome = useCallback(() => setChrome(v => !v), []);
  const bumpChrome = useCallback(() => setTouches(n => n + 1), []);
  useEffect(() => {
    Animated.timing(chromeAnim, {
      toValue: chrome ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [chrome, chromeAnim]);

  useEffect(() => {
    void pip.isSupported().then(setPipSupported);
  }, []);
  useEffect(() => {
    setLastSpoke(prev => updateLastSpoke(prev, s.participants, Date.now()));
  }, [s.participants]);

  // Back closes the top-most thing first (dialog, menu, panel) before the
  // overlay's own Back (minimize) gets it.
  const anyOpen = leaveOpen || menu || shareOpen || tab !== null;
  useEffect(() => {
    if (!anyOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (leaveOpen) setLeaveOpen(false);
      else if (shareOpen) setShareOpen(false);
      else if (menu) setMenu(false);
      else {
        Keyboard.dismiss();
        setTab(null);
      }
      return true;
    });
    return () => sub.remove();
  }, [anyOpen, leaveOpen, shareOpen, menu]);

  const live = s.phase === 'connected' || s.phase === 'reconnecting';

  // A sheet, menu, dialog or the keyboard needs the controls: never hide them
  // under it, and never auto-hide while one is open.
  const busy = anyOpen || kb > 0;
  useEffect(() => {
    if (busy && !chrome) setChrome(true);
  }, [busy, chrome]);
  // Auto-hide after a few idle seconds. `touches` restarts the countdown.
  useEffect(() => {
    if (!live || !chrome || busy) return;
    const t = setTimeout(() => setChrome(false), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [live, chrome, busy, touches]);

  const now = useClock(live);
  // An ad-hoc call is a call: "Call notes", "Leave call" — not meeting wording.
  const noun = s.adhoc ? 'call' : 'meeting';
  const title = s.title || (s.adhoc ? CONFERENCE_TITLE : 'Meeting');

  const plan = useMemo(
    () => pickStage(s.participants, { pinned, lastSpokeAt: lastSpoke }),
    [s.participants, pinned, lastSpoke],
  );
  const togglePin = useCallback(
    (p: RoomParticipantView) =>
      setPinned(cur => (cur === p.identity ? null : p.identity)),
    [],
  );

  // ── lobby (joining / waiting room) ────────────────────────────────────
  if (!live) {
    return (
      <View style={styles.fill}>
        <LinearGradient
          colors={skin.gradient}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.lobby,
            { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
          ]}
        >
          <View
            style={[styles.lobbyIcon, { backgroundColor: skin.accentSoft }]}
          >
            {s.phase === 'joining' ? (
              <ActivityIndicator color={skin.accent} size="large" />
            ) : (
              <Users size={40} color={skin.accent} />
            )}
          </View>
          <Text
            style={[styles.lobbyTitle, { color: skin.ink }]}
            numberOfLines={2}
          >
            {title}
          </Text>
          <Text style={[styles.lobbySub, { color: skin.muted }]}>
            {s.phase === 'joining'
              ? 'Joining…'
              : s.canStart
                ? 'This meeting has not started yet.'
                : 'Waiting for the host to start the meeting…'}
          </Text>
          <View style={styles.lobbyActions}>
            {s.phase === 'waiting' && s.canStart ? (
              <Pressable
                onPress={() => void room.startNow()}
                accessibilityRole="button"
                style={[styles.pill, { backgroundColor: skin.accent }]}
              >
                <VideoIcon size={18} color={skin.accentInk} />
                <Text style={[styles.pillText, { color: skin.accentInk }]}>
                  Start meeting
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => room.leave()}
              accessibilityRole="button"
              style={[styles.pill, { backgroundColor: skin.danger }]}
            >
              <PhoneOff size={18} color="#fff" />
              <Text style={[styles.pillText, { color: '#fff' }]}>Leave</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // ── layout numbers ────────────────────────────────────────────────────
  const topInset = insets.top;
  const bottomInset = insets.bottom;
  const stageTop = topInset + HEADER_H;
  const stagePad = 10;
  const stageW =
    width - stagePad * 2 - (landscape ? insets.left + insets.right : 0);
  const stageH = Math.max(160, height - stageTop - controlsH - stagePad);
  const panelBottom = kb > 0 ? kb + 8 : controlsH + 4;
  // Never taller than the space between the header and the controls/keyboard.
  const panelH = Math.max(
    220,
    Math.min(Math.round(height * 0.72), height - panelBottom - stageTop - 8),
  );

  const meetingLabel =
    s.phase === 'reconnecting'
      ? 'Reconnecting…'
      : formatElapsed(now - (s.connectedAt ?? now));
  const canShare = s.canShareScreen && Platform.OS === 'android';

  const doLeave = () => {
    setLeaveOpen(false);
    room.leave();
  };
  const doEnd = () => {
    setLeaveOpen(false);
    room.endForAll();
  };

  const menuItems: MenuItem[] = [
    { key: 'add', label: 'Add member', icon: UserPlus, onPress: add.open },
    {
      key: 'notes',
      label: s.adhoc ? 'Call notes' : 'Meeting notes',
      icon: StickyNote,
      onPress: () => setTab('notes'),
    },
    {
      key: 'info',
      label: s.adhoc ? 'Call info' : 'Meeting info',
      icon: Info,
      onPress: () => setTab('people'),
    },
    {
      key: 'flip',
      label: 'Flip camera',
      icon: SwitchCamera,
      onPress: () => void room.switchCamera(),
      hidden: !s.camOn,
    },
    {
      key: 'spk',
      label: s.speakerOn ? 'Use earpiece' : 'Use speaker',
      icon: s.speakerOn ? VolumeX : Volume2,
      onPress: () => room.toggleSpeaker(),
    },
    {
      key: 'pip',
      label: 'Picture-in-picture',
      icon: PictureInPicture2,
      onPress: () => void pip.enter(),
      // A real PiP window is drawn over whatever the user switches to next, so it
      // would be captured by an active screen share (the meeting appearing inside
      // its own shared screen) — offer it only when there is nothing to leak into.
      hidden: !pipSupported || s.sharing,
    },
    {
      key: 'min',
      label: 'Minimize',
      icon: ChevronDown,
      onPress: () => meetingUi.minimize(),
    },
    {
      key: 'leave',
      label: `Leave ${noun}`,
      icon: PhoneOff,
      onPress: () => setLeaveOpen(true),
      danger: true,
    },
  ];

  const openTab = (t: PanelTab) => setTab(cur => (cur === t ? null : t));

  return (
    // The provider spans the panels, menu and dialog too: they are SIBLINGS of
    // the blur target (not inside it) and each needs its ref to blur it.
    <StageBlurTarget.Provider value={stageRef}>
      <View style={styles.fill}>
        {/* The live meeting: what every panel/menu/dialog blurs. */}
        <View style={styles.fill}>
          <BlurTargetView ref={stageRef} style={StyleSheet.absoluteFill}>
            <LinearGradient
              colors={skin.gradient}
              style={StyleSheet.absoluteFill}
            />
            {/* A tap ANYWHERE on the meeting shows / hides the controls, including on
                the empty band where hidden controls were. */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={toggleChrome}
              accessible={false}
            />

            {/* header */}
            <Animated.View
              pointerEvents={chrome ? 'auto' : 'none'}
              onTouchStart={bumpChrome}
              style={[
                styles.header,
                { paddingTop: topInset, height: topInset + HEADER_H },
                {
                  opacity: chromeAnim,
                  transform: [
                    {
                      translateY: chromeAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-16, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Pressable
                onPress={() => meetingUi.minimize()}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Minimize meeting"
                style={styles.hBtn}
              >
                <ArrowLeft size={24} color={skin.ink} />
              </Pressable>
              <View style={styles.hTitle}>
                <Text
                  style={[styles.title, { color: skin.ink }]}
                  numberOfLines={1}
                >
                  {title}
                </Text>
                <View style={styles.subRow}>
                  <View
                    style={[
                      styles.liveDot,
                      {
                        backgroundColor:
                          s.phase === 'reconnecting'
                            ? skin.danger
                            : skin.success,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.clock,
                      {
                        color:
                          s.phase === 'reconnecting' ? skin.danger : skin.muted,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {meetingLabel} | {participantCountLabel(s.participants.length)}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => setMenu(true)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="More options"
                style={styles.hBtn}
              >
                <MoreVertical size={22} color={skin.ink} />
              </Pressable>
            </Animated.View>

            {/* stage */}
            <View
              style={{
                position: 'absolute',
                top: stageTop,
                left: stagePad + (landscape ? insets.left : 0),
                width: stageW,
                height: stageH,
              }}
            >
              <MeetingStage
                plan={plan}
                onTap={toggleChrome}
                width={stageW}
                height={stageH}
                landscape={landscape}
                pinned={pinned}
                onTogglePin={togglePin}
                overlay={
                  plan.mode === 'alone' ? (
                    <View style={styles.aloneHint} pointerEvents="box-none">
                      <View
                        style={[
                          styles.aloneCard,
                          { backgroundColor: skin.scrim },
                        ]}
                      >
                        <Text
                          style={{
                            color: skin.ink,
                            fontWeight: '700',
                            textAlign: 'center',
                          }}
                        >
                          You're the only one here
                        </Text>
                        <Pressable
                          onPress={add.open}
                          accessibilityRole="button"
                          style={[
                            styles.pillSm,
                            { backgroundColor: skin.accent },
                          ]}
                        >
                          <UserPlus size={15} color={skin.accentInk} />
                          <Text
                            style={{
                              color: skin.accentInk,
                              fontWeight: '800',
                              fontSize: 13,
                            }}
                          >
                            Add member
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null
                }
              />
              {s.sharing ? (
                <View
                  style={[styles.shareBanner, { backgroundColor: skin.accent }]}
                  accessibilityLiveRegion="polite"
                >
                  <ScreenShare size={16} color={skin.accentInk} />
                  <Text
                    style={{
                      color: skin.accentInk,
                      fontWeight: '800',
                      flex: 1,
                      fontSize: 13,
                    }}
                    numberOfLines={1}
                  >
                    You're sharing your screen
                  </Text>
                  <Pressable
                    onPress={() => void room.toggleScreenShare()}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Stop sharing"
                    style={styles.stopShare}
                  >
                    <Text
                      style={{
                        color: skin.accentInk,
                        fontWeight: '900',
                        fontSize: 12,
                      }}
                    >
                      STOP
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </BlurTargetView>
        </View>

        {/* toasts (Add member outcome) */}
        {add.notice || add.progress ? (
          <View
            style={[styles.toastWrap, { top: stageTop + 6 }]}
            pointerEvents="box-none"
          >
            <GlassPanel radius={16} style={styles.toast}>
              <View style={styles.toastInner}>
                {add.progress && !add.notice ? (
                  <ActivityIndicator size="small" color={skin.accent} />
                ) : null}
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: '600',
                    color:
                      add.notice?.tone === 'success'
                        ? skin.success
                        : add.notice
                          ? skin.danger
                          : skin.ink,
                  }}
                >
                  {add.notice
                    ? add.notice.text
                    : `Adding ${Math.min(
                      add.progress!.done + 1,
                      add.progress!.total,
                    )} of ${add.progress!.total}…`}
                </Text>
                {add.notice ? (
                  <Pressable
                    onPress={add.dismissNotice}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                  >
                    <X size={16} color={skin.muted} />
                  </Pressable>
                ) : null}
              </View>
            </GlassPanel>
          </View>
        ) : null}

        {/* controls: a glass bar overlaid at the bottom. Hidden = faded out and
            not touchable (taps fall through to the stage, which shows them again). */}
        {kb === 0 ? (
          <Animated.View
            pointerEvents={chrome ? 'box-none' : 'none'}
            onTouchStart={bumpChrome}
            style={[
              styles.controls,
              { paddingBottom: Math.max(bottomInset, 8) },
              {
                opacity: chromeAnim,
                transform: [
                  {
                    translateY: chromeAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [24, 0],
                    }),
                  },
                ],
              },
            ]}
            onLayout={e =>
              setControlsH(Math.round(e.nativeEvent.layout.height))
            }
          >
            <GlassPanel radius={28} style={styles.controlsGlass}>
              <View style={styles.controlsInner}>
                <View style={styles.row}>
                  {canShare ? (
                    <ControlButton
                      icon={s.sharing ? ScreenShareOff : ScreenShare}
                      label={s.sharing ? 'Stop' : 'Share'}
                      active={s.sharing}
                      onPress={() =>
                        s.sharing
                          ? void room.toggleScreenShare()
                          : setShareOpen(true)
                      }
                    />
                  ) : null}
                  <ControlButton
                    icon={s.micOn ? Mic : MicOff}
                    label={s.micOn ? 'Mute' : 'Unmute'}
                    off={!s.micOn}
                    onPress={() => void room.toggleMic()}
                  />
                  <ControlButton
                    icon={s.camOn ? VideoIcon : VideoOff}
                    label="Camera"
                    off={!s.camOn}
                    onPress={() => void room.toggleCam()}
                  />
                  <ControlButton
                    icon={Users}
                    label="Members"
                    active={tab === 'people'}
                    onPress={() => openTab('people')}
                  />
                  <ControlButton
                    icon={MessageCircle}
                    label="Chat"
                    active={tab === 'chat'}
                    badge={tab === 'chat' ? 0 : data.unread}
                    onPress={() => openTab('chat')}
                  />
                  <ControlButton
                    icon={Hand}
                    label={s.handRaised ? 'Lower' : 'Raise'}
                    active={s.handRaised}
                    onPress={() => void room.toggleRaiseHand()}
                    testID="raise-hand-btn"
                  />
                  <ControlButton
                    icon={MoreHorizontal}
                    label="More"
                    active={menu}
                    onPress={() => setMenu(true)}
                  />
                  {landscape ? (
                    <EndButton
                      label="Leave"
                      icon={PhoneOff}
                      compact
                      onPress={() => setLeaveOpen(true)}
                    />
                  ) : null}
                </View>
                {landscape ? null : (
                  <EndButton
                    label="Leave"
                    icon={PhoneOff}
                    onPress={() => setLeaveOpen(true)}
                  />
                )}
              </View>
            </GlassPanel>
          </Animated.View>
        ) : null}

        {/* panel: chat / participants / notes */}
        {tab ? (
          <MeetingPanel
            tab={tab}
            onTab={setTab}
            onClose={() => {
              Keyboard.dismiss();
              setTab(null);
            }}
            participants={s.participants}
            invited={add.invited}
            onAddMember={add.open}
            addBusy={!!add.progress}
            isHost={s.isHost}
            height={panelH}
            bottom={panelBottom}
          />
        ) : null}

        {shareOpen ? (
          <ShareSheet
            onClose={() => setShareOpen(false)}
            onStart={() => {
              setShareOpen(false);
              void room.toggleScreenShare();
            }}
          />
        ) : null}

        {menu ? (
          <MeetingMenu
            items={menuItems}
            top={topInset + HEADER_H - 6}
            onClose={() => setMenu(false)}
          />
        ) : null}
        {leaveOpen ? (
          <LeaveDialog
            title={title}
            isHost={s.isHost}
            adhoc={s.adhoc}
            onCancel={() => setLeaveOpen(false)}
            onLeave={doLeave}
            onEndForAll={doEnd}
          />
        ) : null}
      </View>
    </StageBlurTarget.Provider>
  );
}

/**
 * How far the keyboard covers the bottom of the window. Computed from where the
 * keyboard's top edge is versus the window's bottom, so it is right both when
 * Android resizes the window for the keyboard (offset ~0) and when it does not
 * (edge-to-edge: offset = keyboard height).
 */
function useKeyboardOffset(): number {
  const { height } = useWindowDimensions();
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e =>
      setTop(e.endCoordinates.screenY),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return top === null ? 0 : Math.max(0, Math.round(height - top));
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 6,
  },
  hBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hTitle: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '800' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  clock: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  count: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 32,
    paddingHorizontal: 11,
    borderRadius: 16,
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 6,
    paddingHorizontal: 8,
  },
  controlsGlass: { alignSelf: 'stretch' },
  controlsInner: { paddingTop: 12, paddingBottom: 12, paddingHorizontal: 6, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  aloneHint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 16,
  },
  aloneCard: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 18,
    gap: 10,
    alignItems: 'center',
  },
  pillSm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
  },
  shareBanner: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  stopShare: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  toastWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  toast: { width: '100%', maxWidth: 420 },
  toastInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  lobby: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 14,
  },
  lobbyIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lobbyTitle: { fontSize: 24, fontWeight: '800', textAlign: 'center' },
  lobbySub: { fontSize: 15, textAlign: 'center' },
  lobbyActions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 46,
    paddingHorizontal: 22,
    borderRadius: 23,
  },
  pillText: { fontSize: 15, fontWeight: '800' },
});
