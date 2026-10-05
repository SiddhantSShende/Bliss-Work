import { MonitorSmartphone, ScreenShare } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassBackdrop, GlassPanel } from './Glass';
import { useMeetingSkin } from './skin';

/**
 * "Share your screen" confirmation shown before capture starts. Start Sharing
 * calls the real screen-share toggle (Android MediaProjection through LiveKit);
 * Android then shows its own prompt, where the user picks the entire screen or
 * (Android 14+) a single app window — that choice is the system's, so it is
 * described here rather than faked as an in-app radio list. No preview is shown:
 * Android exposes none before capture begins.
 */
export function ShareSheet({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  const skin = useMeetingSkin();
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <GlassBackdrop onPress={onClose} />
      <View style={styles.wrap} pointerEvents="box-none">
        <GlassPanel style={styles.card} radius={24}>
          <View style={styles.inner}>
            <View style={[styles.icon, { backgroundColor: skin.accentSoft }]}>
              <ScreenShare size={28} color={skin.accent} />
            </View>
            <Text style={[styles.title, { color: skin.ink }]}>Share your screen</Text>
            <Text style={[styles.body, { color: skin.muted }]}>
              Everyone in the meeting will see what is on your screen, live. Android will ask what to share.
            </Text>
            <View style={[styles.row, { borderColor: skin.accent, backgroundColor: skin.accentSoft }]}>
              <MonitorSmartphone size={20} color={skin.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: skin.ink }]}>Entire screen or a single app</Text>
                <Text style={[styles.rowSub, { color: skin.muted }]}>Choose in Android's prompt</Text>
              </View>
            </View>
            <Pressable
              onPress={onStart}
              accessibilityRole="button"
              accessibilityLabel="Start sharing"
              style={({ pressed }) => [styles.start, { backgroundColor: skin.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <ScreenShare size={18} color={skin.accentInk} />
              <Text style={[styles.startText, { color: skin.accentInk }]}>Start Sharing</Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.cancel}>
              <Text style={{ color: skin.muted, fontWeight: '700' }}>Cancel</Text>
            </Pressable>
          </View>
        </GlassPanel>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 400 },
  inner: { padding: 22, gap: 12, alignItems: 'center' },
  icon: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 19, fontWeight: '800' },
  body: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  row: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 1 },
  start: { alignSelf: 'stretch', height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  startText: { fontSize: 15, fontWeight: '800' },
  cancel: { paddingVertical: 6 },
});
