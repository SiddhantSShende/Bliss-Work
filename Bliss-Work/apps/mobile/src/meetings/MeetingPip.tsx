import { useMemo } from 'react';
import { MicOff } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { Avatar } from '../components/Avatar';
import type { CallSnapshot } from '../calls/callController';
import type { RoomSnapshot } from '../calls/roomController';
import { pickStage } from './layout';
import { Tile } from './MeetingStage';
import { useMeetingSkin } from './skin';

/**
 * What the system Picture-in-Picture window shows: the person (or shared
 * screen) on stage, their name and mute state, nothing else. No controls: the
 * PiP window is tiny and the system draws its own (tap to expand).
 */
export function MeetingPip({ room }: { room: RoomSnapshot }) {
  const skin = useMeetingSkin();
  const plan = useMemo(() => pickStage(room.participants), [room.participants]);
  return (
    <View style={[styles.fill, { backgroundColor: skin.gradient[0] }]}>
      {plan.stage ? (
        // '100%': the PiP window's size is chosen by the system, so the tile
        // simply fills it (no measuring: layout events are unreliable mid-transition).
        <Tile p={plan.stage} width="100%" height="100%" screen={plan.stageIsScreen} large />
      ) : (
        <View style={styles.center}>
          <Text style={{ color: skin.muted }}>{room.title || 'Meeting'}</Text>
        </View>
      )}
    </View>
  );
}

/** PiP for a 1:1 call: the peer's video, or their avatar. */
export function CallPip({ call }: { call: CallSnapshot }) {
  const skin = useMeetingSkin();
  const showVideo = (call.peerCamOn || call.peerSharing) && !!call.remoteStream;
  const name = call.peerName ?? 'Call';
  return (
    <View style={[styles.fill, { backgroundColor: skin.gradient[0] }]}>
      {showVideo ? (
        <RTCView
          streamURL={call.remoteStream!.toURL()}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
        />
      ) : (
        <View style={styles.center}>
          <Avatar name={name} size={64} />
          <Text
            style={{ color: skin.ink, fontWeight: '700', marginTop: 8 }}
            numberOfLines={1}
          >
            {name}
          </Text>
        </View>
      )}
      {!call.micOn ? (
        <View style={styles.muted}>
          <MicOff size={14} color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  muted: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
});
