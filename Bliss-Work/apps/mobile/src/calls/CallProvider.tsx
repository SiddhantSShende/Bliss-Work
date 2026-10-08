import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EventType, type ServerEvent, type UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { qk } from '../hooks/queryKeys';
import { CallController, type CallMedia, type CallSnapshot } from './callController';
import { RoomController, type RoomSnapshot } from './roomController';
import { MobileCallSession } from './MobileCallSession';
import { LiveKitRoomAdapter } from './LiveKitRoomAdapter';
import { applySpeaker, startCallAudio, stopCallAudio } from './audio';
import { parseCallLink } from './callLinks';
import { joinFromCallLink } from './callLinkJoin';
import { roomInviteFor } from './roomInvites';
import { canUseFullScreenIntent, openFullScreenIntentSettings, releaseLockScreen } from './incomingCallNative';
import { cancelAllMeetingReminders, onMeetingReminderResponse, setInMeetingCheck, syncMeetingReminders } from './meetingReminders';
import { MeetingHub } from '../meetings/meetingHub';
import type { MeetingDataSnapshot } from '../meetings/meetingData';
import { alertCameraUnavailable, alertScreenShareFailed, ensureCallPermissions, ensureCameraPermission } from './permissions';
import { screenSecurity } from '../security/screenSecurity';
import {
  dismissIncomingCallNotification,
  initCallNotifications,
  onCallNotificationResponse,
  requestCallNotificationPermission,
  showIncomingCallNotification,
  showMissedCallNotification,
} from './notifications';

/**
 * Owns the two call state machines for the signed-in app and everything they
 * need from the platform: the shared realtime transport, notifications, audio
 * routing, permissions and deep links. Mounted once, inside the authed tree
 * (see RootNavigator). The call UI reads it through `useCalls()`.
 *
 * Nothing here ever opens a browser: a "call link" — BlissWork's own deep link
 * or its web URL — is parsed and joined in-app (see `openCallLink`).
 */

interface CallsContextValue {
  direct: CallController;
  room: RoomController;
  /** Voice/video call to one person — the 1:1 ring protocol web/desktop use. */
  startDirectCall: (peerId: string, peerName: string, media: CallMedia) => void;
  /** Start (or join the live) call in a channel. */
  startChannelCall: (channelId: string, channelName: string, media: CallMedia) => Promise<void>;
  /** Join a meeting / room call by id. */
  joinMeeting: (callId: string, media?: CallMedia, title?: string) => void;
  /** Open `url` in-app if it is a BlissWork call link. Returns whether it was
   *  handled; anything else is for the caller to open as it always did. */
  openCallLink: (url: string) => boolean;
  /** Chat + notes of the meeting that is live (empty otherwise). */
  meetingHub: MeetingHub;
}

const CallsContext = createContext<CallsContextValue | null>(null);

/** Re-dial the socket when the app returns after at least this long away. */
const REDIAL_AFTER_BACKGROUND_MS = 20_000;

/** Explicit consent before a LINK joins a call (see callLinkJoin). Dismissing
 *  the dialog (back button / tap outside) counts as Cancel. */
const confirmJoinFromLink = () =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      'Join this call?',
      'A call link was opened. You will join with your microphone and camera off; turn them on once you are in.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Join', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const dbg = (event: string, data?: Record<string, string | number | boolean | undefined>) => {
  // Ids, states and phases only — never tokens, SDP, or credentials.
  if (__DEV__) console.debug('[call]', event, data ?? '');
};

const FSI_PROMPTED_KEY = 'call-fullscreen-prompted';

/**
 * Android 14+ can revoke the "full-screen notifications" special access that
 * lets a ringing call take over the screen. Without it a call still rings as a
 * heads-up notification, but not over a locked/off screen. Ask ONCE, plainly,
 * and send the user to the exact system page; never nag.
 */
async function offerFullScreenCalls(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (await canUseFullScreenIntent()) return;
    if ((await AsyncStorage.getItem(FSI_PROMPTED_KEY)) === '1') return;
    await AsyncStorage.setItem(FSI_PROMPTED_KEY, '1');
    Alert.alert(
      'Show incoming calls on your lock screen?',
      'Allow full-screen notifications so BlissWork calls can ring over a locked or sleeping screen, like a phone call.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open settings', onPress: openFullScreenIntentSettings },
      ],
    );
  } catch (e) {
    dbg('fsi.check.failed', { error: String(e) });
  }
}

export function CallProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { api, ws, rtc, config } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user);
  const meRef = useRef<UserDTO | null>(me);
  meRef.current = me;

  const refreshCalls = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.myCalls });
    void qc.invalidateQueries({ queryKey: qk.callHistory });
    void qc.invalidateQueries({ queryKey: qk.callsRangePrefix });
  }, [qc]);

  const cachedName = useCallback(
    (userId: string) => qc.getQueryData<UserDTO[]>(qk.directory)?.find((u) => u.id === userId)?.displayName,
    [qc],
  );

  const controllers = useMemo(() => {
    const direct: CallController = new CallController({
      rtc,
      api,
      selfId: () => meRef.current?.id,
      createSession: (o) => new MobileCallSession(o),
      newId: () => crypto.randomUUID(),
      ensurePermissions: ensureCallPermissions,
      ensureCamera: ensureCameraPermission,
      cameraFailed: alertCameraUnavailable,
      cachedName,
      resolveName: async (userId) => {
        if (cachedName(userId)) return cachedName(userId);
        try {
          const dir = await qc.fetchQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
          return dir.find((u) => u.id === userId)?.displayName;
        } catch {
          return undefined;
        }
      },
      applySpeaker,
      // A room call already holds the microphone: a second, peer-to-peer call
      // on top of it can only fail, so the caller is told we are busy.
      isBusy: () => roomRef.current?.busy ?? false,
      onIncoming: (c) => {
        void showIncomingCallNotification({ ...c, kind: 'direct' }).catch((e) => dbg('notify.failed', { error: String(e) }));
      },
      onIncomingDone: (callId) => void dismissIncomingCallNotification(callId),
      onMissed: (name, media) => void showMissedCallNotification(name, media).catch((e) => dbg('notify.failed', { error: String(e) })),
      // The call was widened into a group: the SFU room owns the media now.
      onEnterRoom: (callId, media) => void roomRef.current?.join(callId, media, 'Group call'),
      onRecordChanged: refreshCalls,
      log: dbg,
    });
    const roomRef: { current?: RoomController } = {};
    const room = new RoomController({
      api,
      createRoom: () => new LiveKitRoomAdapter(),
      onCallEvent: (cb) =>
        ws.on((e) => {
          if (e.type === EventType.CallStarted) cb({ type: 'started', callId: e.callId });
          else if (e.type === EventType.CallEnded) cb({ type: 'ended', callId: e.callId });
        }),
      ensurePermissions: ensureCallPermissions,
      ensureCamera: ensureCameraPermission,
      cameraFailed: alertCameraUnavailable,
      screenShareFailed: alertScreenShareFailed,
      // Lifted only for the live duration of a real screen share — see
      // screenSecurity.ts's own doc for why the app can't be both protected
      // and self-capturable at the same instant.
      onScreenShareChanged: (sharing) => screenSecurity.setProtected(!sharing),
      applySpeaker,
      onRinging: (c) => {
        void showIncomingCallNotification({
          callId: c.callId,
          name: c.inviter ?? 'Someone',
          media: c.media,
          kind: 'room',
          context: c.title,
        }).catch((e) => dbg('notify.failed', { error: String(e) }));
      },
      onRingingDone: (callId) => void dismissIncomingCallNotification(callId),
      onRecordChanged: refreshCalls,
      log: dbg,
    });
    roomRef.current = room;
    return { direct, room };
  }, [api, rtc, ws, qc, cachedName, refreshCalls]);

  const { direct, room } = controllers;

  // Chat/notes of the live meeting: created when a room connects, disposed
  // when it ends, so nothing carries into the next meeting.
  const meetingHub = useMemo(
    () =>
      new MeetingHub({
        room: {
          getSnapshot: room.getSnapshot,
          subscribe: room.subscribe,
          sendData: (bytes, to) => room.sendData(bytes, to),
          onData: (cb) => room.onData(cb),
        },
        api,
        selfIdentity: () => meRef.current?.id,
        selfName: () => meRef.current?.displayName ?? 'Me',
        nameOf: cachedName,
        log: dbg,
      }),
    [room, api, cachedName],
  );
  useEffect(() => () => meetingHub.dispose(), [meetingHub]);

  // ── lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const stop = direct.start();
    return () => {
      stop();
      room.dispose();
    };
  }, [enabled, direct, room]);

  // Notification channels/actions + permission (Android 13+/iOS prompt).
  useEffect(() => {
    if (!enabled) return;
    void initCallNotifications()
      .then(() => requestCallNotificationPermission())
      .then((granted) => dbg('notify.permission', { granted }))
      .catch((e) => dbg('notify.init.failed', { error: String(e) }));
    void offerFullScreenCalls();
  }, [enabled]);

  // A phone that was in the background can come back holding a socket the OS
  // silently killed: RN only notices on the next heartbeat (20s ping + 10s
  // pong wait), and a ring sent in that window (the frame is ephemeral and is
  // not replayed) is lost. Coming back after a while, re-dial instead of
  // trusting it. Never mid-call: that would drop the call's signalling.
  useEffect(() => {
    if (!enabled) return;
    let leftAt: number | null = null;
    let redial: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') {
        leftAt ??= Date.now();
        return;
      }
      const away = leftAt === null ? 0 : Date.now() - leftAt;
      leftAt = null;
      const idle = direct.getSnapshot().phase === 'idle' && room.getSnapshot().phase === 'idle';
      if (away >= REDIAL_AFTER_BACKGROUND_MS && idle) {
        dbg('ws.redial', { awayMs: away });
        ws.close();
        // Give the old socket's close event time to land first: it clears the
        // heartbeat timers, which must not be the new socket's.
        if (redial) clearTimeout(redial);
        redial = setTimeout(() => void ws.connect(), 300);
      } else {
        void ws.connect(); // idempotent; also revives a client that gave up
      }
    });
    return () => {
      sub.remove();
      if (redial) clearTimeout(redial);
    };
  }, [enabled, ws, direct, room]);

  // Audio route follows the call: taken while a call is live, returned after.
  // Video defaults to the loudspeaker, voice to the earpiece.
  const directPhase = useSyncExternalStore(direct.subscribe, () => direct.getSnapshot().phase);
  const roomPhase = useSyncExternalStore(room.subscribe, () => room.getSnapshot().phase);
  const directMedia = useSyncExternalStore(direct.subscribe, () => direct.getSnapshot().media);
  const inCall =
    directPhase === 'outgoing' ||
    directPhase === 'connecting' ||
    directPhase === 'connected' ||
    directPhase === 'reconnecting' ||
    roomPhase === 'joining' ||
    roomPhase === 'waiting' ||
    roomPhase === 'connected' ||
    roomPhase === 'reconnecting';
  useEffect(() => {
    if (!inCall) {
      void stopCallAudio();
      return;
    }
    void startCallAudio().then(() => {
      // Forced: starting the session resets the route to the earpiece, and the
      // snapshot may already say "speaker" from the previous call, in which
      // case a plain setSpeaker(true) would be a no-op and leave a video call
      // on the earpiece. Room calls choose their route before the session
      // exists, so it is re-applied here as well.
      if (direct.getSnapshot().phase !== 'idle') direct.setSpeaker(directMedia === 'video', true);
      else applySpeaker(room.getSnapshot().speakerOn);
    });
  }, [inCall, direct, directMedia]);

  // A call launched the app over the lock screen (native ring, Android): once
  // nothing is ringing or live any more, let the phone lock again.
  useEffect(() => {
    if (enabled && directPhase === 'idle' && roomPhase === 'idle') releaseLockScreen();
  }, [enabled, directPhase, roomPhase]);

  // ── room invites from server events (channel calls, meetings, "added") ───
  useEffect(() => {
    if (!enabled) return;
    const nameOf = (id?: string) => (id ? cachedName(id) : undefined);
    return ws.on((e: ServerEvent, meta) => {
      if (!e.type.startsWith('call.')) return;
      const d = roomInviteFor(e, { me: meRef.current?.id, replayed: meta.replayed });
      dbg('call.event', { type: e.type, decision: d?.kind ?? 'ignore', replayed: meta.replayed });
      if (!d) return;
      if (d.kind === 'dismiss') {
        room.dismissInvite(d.callId);
        return;
      }
      const announce = () => room.announce(d.callId, d.title, d.media, nameOf(d.actorId), d.actorId);
      if (d.directDuplicate) {
        // A 1:1 call also creates a call row, which raises these events on
        // top of the WS ring that already reached us. Give that ring a
        // moment to land; if we are on a call by then, this is the same
        // call, not a second one.
        setTimeout(() => {
          if (direct.getSnapshot().phase === 'idle') announce();
        }, 1500);
      } else if (direct.getSnapshot().phase === 'idle') {
        announce();
      }
    });
  }, [enabled, ws, room, direct, cachedName]);

  // ── notification actions (Accept / Decline / tap) ────────────────────────
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    return onCallNotificationResponse((r) => {
      const key = `${r.callId}:${r.action}`;
      if (handled.current.has(key)) return;
      handled.current.add(key);
      dbg('notification', { action: r.action, kind: r.kind });
      const d = direct.getSnapshot();
      const rm = room.getSnapshot();
      if (r.kind === 'direct' && d.phase === 'incoming' && d.callId === r.callId) {
        if (r.action === 'accept') void direct.accept();
        else if (r.action === 'decline') direct.decline();
        // 'open': the in-app ring screen is already showing.
      } else if (r.kind === 'room' && rm.phase === 'ringing' && rm.callId === r.callId) {
        if (r.action === 'accept') void room.join(r.callId, rm.media, rm.title);
        else if (r.action === 'decline') room.decline();
      }
    });
  }, [enabled, direct, room]);

  // ── meeting reminders (10 minutes before) ────────────────────────────────
  // The user's upcoming meetings (creator and invitee alike). Whenever this list
  // changes — a meeting scheduled, moved, cancelled, or removed — the device's
  // pending reminders are reconciled to match. See meetingReminders.ts.
  const { data: myCalls } = useQuery({ queryKey: qk.myCalls, queryFn: () => api.myCalls(), enabled });
  useEffect(() => {
    if (!enabled || !myCalls) return;
    syncMeetingReminders(myCalls).catch((e) => dbg('reminders.sync.failed', { error: String(e) }));
  }, [enabled, myCalls]);
  // Back from the background: pick up changes made while the app was away.
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void qc.invalidateQueries({ queryKey: qk.myCalls });
    });
    return () => sub.remove();
  }, [enabled, qc]);
  // Signing out must not leave this account's reminders on the device.
  useEffect(() => {
    if (!enabled) return;
    return () => void cancelAllMeetingReminders();
  }, [enabled]);
  // A reminder that fires while the user is already in that meeting is skipped.
  useEffect(() => {
    setInMeetingCheck((callId) => {
      const r = room.getSnapshot();
      return r.callId === callId && r.phase !== 'idle' && r.phase !== 'ringing' && r.phase !== 'ended';
    });
  }, [room]);
  // Tap / Join on a reminder: open THIS meeting in-app (its own id, no new
  // meeting, no browser) — after checking it still exists.
  const handledReminders = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    return onMeetingReminderResponse(({ callId }) => {
      if (handledReminders.current.has(callId)) return;
      handledReminders.current.add(callId);
      setTimeout(() => handledReminders.current.delete(callId), 10_000);
      void api
        .call(callId)
        .then((call) => {
          if (call.status === 'CANCELLED' || call.status === 'ENDED') {
            Alert.alert('Meeting unavailable', `${call.title || 'This meeting'} was ${call.status === 'CANCELLED' ? 'cancelled' : 'already ended'}.`);
            void qc.invalidateQueries({ queryKey: qk.myCalls });
            return;
          }
          void room.join(call.id, call.media, call.title || undefined);
        })
        .catch(() => Alert.alert("Couldn't open the meeting", 'Please try again from the Meetings tab.'));
    });
  }, [enabled, api, room, qc]);

  // ── links ────────────────────────────────────────────────────────────────
  const joinMeeting = useCallback(
    (callId: string, media?: CallMedia, title?: string) => void room.join(callId, media ?? 'video', title),
    [room],
  );

  // One confirmation at a time: a cold-start URL can arrive via both
  // getInitialURL and the 'url' event.
  const linkPrompt = useRef(false);
  const openCallLink = useCallback(
    (url: string): boolean => {
      const link = parseCallLink(url, config.webBaseUrl);
      if (!link) return false;
      dbg('link', { kind: link.kind });
      if (linkPrompt.current) return true;
      linkPrompt.current = true;
      void joinFromCallLink(link, {
        confirm: confirmJoinFromLink,
        redeemToken: (token) => api.joinCallByToken(token),
        join: (id, media, title, opts) => void room.join(id, media, title, opts),
        redeemFailed: () => Alert.alert("Couldn't join the call", 'This invite link may have expired.'),
      }).finally(() => {
        linkPrompt.current = false;
      });
      return true;
    },
    [api, config.webBaseUrl, room],
  );

  // blisswork://call/<id> — warm and cold start.
  useEffect(() => {
    if (!enabled) return;
    const onUrl = (url: string | null) => {
      if (url && /^blisswork:\/\/call\//i.test(url)) openCallLink(url);
    };
    void Linking.getInitialURL().then(onUrl);
    const sub = Linking.addEventListener('url', (e) => onUrl(e.url));
    return () => sub.remove();
  }, [enabled, openCallLink]);

  // ── actions ──────────────────────────────────────────────────────────────
  const startDirectCall = useCallback(
    (peerId: string, peerName: string, media: CallMedia) => {
      if (room.busy) {
        Alert.alert('You are already in a call');
        return;
      }
      void direct.invite(peerId, peerName, media);
    },
    [direct, room],
  );

  const startChannelCall = useCallback(
    async (channelId: string, channelName: string, media: CallMedia) => {
      if (room.busy || direct.getSnapshot().phase !== 'idle') {
        Alert.alert('You are already in a call');
        return;
      }
      try {
        // Join the call already running in this channel instead of starting a
        // second one on top of it.
        const running = (await api.channelCalls(channelId)).find((c) => c.status === 'LIVE');
        const call = running ?? (await api.scheduleChannelCall(channelId, { media, title: channelName }));
        void room.join(call.id, call.media ?? media, call.title || channelName);
        refreshCalls();
      } catch {
        Alert.alert("Couldn't start the call", 'Please try again.');
      }
    },
    [api, direct, room, refreshCalls],
  );

  // A ring that ended while the app was away should not leave a stale notice.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        const d = direct.getSnapshot();
        if (d.phase !== 'incoming' && d.callId) void dismissIncomingCallNotification(d.callId);
      }
    });
    return () => sub.remove();
  }, [direct]);

  const value = useMemo<CallsContextValue>(
    () => ({ direct, room, startDirectCall, startChannelCall, joinMeeting, openCallLink, meetingHub }),
    [direct, room, startDirectCall, startChannelCall, joinMeeting, openCallLink, meetingHub],
  );
  return <CallsContext.Provider value={value}>{children}</CallsContext.Provider>;
}

export function useCalls(): CallsContextValue {
  const v = useContext(CallsContext);
  if (!v) throw new Error('useCalls outside CallProvider');
  return v;
}

export function useDirectCall(): CallSnapshot {
  const { direct } = useCalls();
  return useSyncExternalStore(direct.subscribe, direct.getSnapshot);
}

export function useRoomCall(): RoomSnapshot {
  const { room } = useCalls();
  return useSyncExternalStore(room.subscribe, room.getSnapshot);
}

/** Chat + notes of the live meeting. */
export function useMeetingData(): MeetingDataSnapshot {
  const { meetingHub } = useCalls();
  return useSyncExternalStore(meetingHub.subscribe, meetingHub.getSnapshot);
}
