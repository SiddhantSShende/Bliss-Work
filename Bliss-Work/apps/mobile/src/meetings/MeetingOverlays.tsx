import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassBackdrop, GlassPanel } from './Glass';
import { useMeetingSkin } from './skin';

/** "Leave Meeting — Are you sure…?" (reference screen 8). A host also gets "End for everyone". */
export function LeaveDialog({
  title,
  isHost,
  adhoc,
  onCancel,
  onLeave,
  onEndForAll,
}: {
  title: string;
  isHost: boolean;
  /** An ad-hoc call: worded as a call. Leaving it never ends it for the others. */
  adhoc?: boolean;
  onCancel: () => void;
  onLeave: () => void;
  onEndForAll: () => void;
}) {
  const skin = useMeetingSkin();
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <GlassBackdrop onPress={onCancel} />
      <View style={styles.dialogWrap} pointerEvents="box-none">
        <GlassPanel style={styles.dialog} radius={24}>
          <View style={styles.dialogInner}>
            <Text style={[styles.dialogTitle, { color: skin.ink }]}>
              {adhoc ? 'Leave Call' : 'Leave Meeting'}
            </Text>
            <Text
              style={[styles.dialogBody, { color: skin.muted }]}
              numberOfLines={3}
            >
              Are you sure you want to leave “{title}”?
            </Text>
            <View style={styles.dialogRow}>
              <DialogButton label="Cancel" onPress={onCancel} tone="neutral" />
              <DialogButton label="Leave" onPress={onLeave} tone="danger" />
            </View>
            {isHost ? (
              <>
                <Text style={[styles.hostNote, { color: skin.faint }]}>
                  {adhoc
                    ? 'The call carries on for the others. As the host you can also end it for everyone.'
                    : 'As the host you can also end the meeting for everyone.'}
                </Text>
                <DialogButton
                  label="End for everyone"
                  onPress={onEndForAll}
                  tone="outline"
                  wide
                />
              </>
            ) : null}
          </View>
        </GlassPanel>
      </View>
    </View>
  );
}

function DialogButton({
  label,
  onPress,
  tone,
  wide,
}: {
  label: string;
  onPress: () => void;
  tone: 'neutral' | 'danger' | 'outline';
  wide?: boolean;
}) {
  const skin = useMeetingSkin();
  const bg =
    tone === 'danger'
      ? skin.danger
      : tone === 'outline'
      ? 'transparent'
      : 'rgba(255,255,255,0.12)';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.dialogBtn,
        // Side by side (flex:1) in a row; full width, natural height, when alone in the column.
        wide && { flex: 0, alignSelf: 'stretch' },
        {
          backgroundColor: bg,
          borderColor: tone === 'outline' ? skin.danger : 'transparent',
          borderWidth: tone === 'outline' ? 1.5 : 0,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: tone === 'outline' ? skin.danger : '#ffffff',
          fontSize: 15,
          fontWeight: '800',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  hidden?: boolean;
  /** Tint the row as destructive. */
  danger?: boolean;
}

/** The "•••" menu: a small glass popover under the header, over the blurred meeting. */
export function MeetingMenu({
  items,
  top,
  onClose,
}: {
  items: MenuItem[];
  top: number;
  onClose: () => void;
}) {
  const skin = useMeetingSkin();
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <GlassBackdrop onPress={onClose} />
      <GlassPanel style={[styles.menu, { top }]} radius={18}>
        {items
          .filter(i => !i.hidden)
          .map(i => {
            const Icon = i.icon;
            const tint = i.danger ? skin.danger : skin.ink;
            return (
              <Pressable
                key={i.key}
                onPress={() => {
                  onClose();
                  i.onPress();
                }}
                accessibilityRole="menuitem"
                style={({ pressed }) => [
                  styles.menuRow,
                  pressed && { backgroundColor: 'rgba(255,255,255,0.1)' },
                ]}
              >
                <Icon size={18} color={tint} />
                <Text style={{ color: tint, fontSize: 14, fontWeight: '600' }}>
                  {i.label}
                </Text>
              </Pressable>
            );
          })}
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  dialogWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  dialog: { width: '100%', maxWidth: 380 },
  dialogInner: { padding: 22, gap: 12 },
  dialogTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  dialogBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  dialogRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  dialogBtn: {
    flex: 1,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hostNote: { fontSize: 12, textAlign: 'center', marginTop: 4 },
  menu: { position: 'absolute', right: 12, minWidth: 210, paddingVertical: 6 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
