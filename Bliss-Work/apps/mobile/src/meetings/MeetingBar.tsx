import { ChevronUp, Mic, MicOff } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCalls, useDirectCall, useRoomCall } from '../calls/CallProvider';
import { formatElapsed } from './layout';
import { meetingUi } from './meetingUi';
import { useClock } from './useClock';
import { useMeetingSkin } from './skin';

/**
 * The slim "you are still in a meeting" bar shown while the full meeting is
 * minimized, so the rest of BlissWork stays usable. The call keeps running
 * (nothing here touches the room); tapping it returns to the full meeting.
 * Deliberately a fixed bar rather than a draggable overlay: Android's real
 * Picture-in-Picture covers the "use another app" case (see pip.ts).
 */
export function MeetingBar() {
  const skin = useMeetingSkin();
  const insets = useSafeAreaInsets();
  const room = useRoomCall();
  const direct = useDirectCall();
  const { room: rc, direct: dc } = useCalls();
  const inRoom = room.phase !== 'idle';
  const title = inRoom ? room.title || 'Meeting' : direct.peerName || 'Call';
  const since = inRoom ? room.connectedAt : direct.connectedAt;
  const micOn = inRoom ? room.micOn : direct.micOn;
  const now = useClock(!!since);
  const toggleMic = () => (inRoom ? void rc.toggleMic() : dc.toggleMic());
  return (
    <View style={[styles.wrap, { top: insets.top + 6 }]} pointerEvents="box-none">
      <Pressable
        onPress={() => meetingUi.restore()}
        accessibilityRole="button"
        accessibilityLabel={`Return to ${title}`}
        style={[styles.bar, { backgroundColor: skin.accent }]}
      >
        <View style={styles.dot} />
        <Text style={[styles.title, { color: skin.accentInk }]} numberOfLines={1}>
          {title}
        </Text>
        {since ? <Text style={[styles.time, { color: skin.accentInk }]}>{formatElapsed(now - since)}</Text> : null}
        <Pressable onPress={toggleMic} hitSlop={8} accessibilityRole="button" accessibilityLabel={micOn ? 'Mute' : 'Unmute'} style={styles.mic}>
          {micOn ? <Mic size={16} color={skin.accentInk} /> : <MicOff size={16} color={skin.accentInk} />}
        </Pressable>
        <ChevronUp size={18} color={skin.accentInk} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingHorizontal: 14, borderRadius: 20, maxWidth: 420, width: '100%' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' },
  title: { flex: 1, fontSize: 14, fontWeight: '800' },
  time: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  mic: { padding: 4 },
});
